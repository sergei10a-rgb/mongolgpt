import { describe, expect, test } from "bun:test"
import {
  SERVICE_MONITOR_ALERT_STATE_MAX_AGE_MS,
  SERVICE_MONITOR_ALERT_STATE_KEY,
  SERVICE_MONITOR_ALERT_STATE_TTL_SECONDS,
  SERVICE_MONITOR_STATE_KEY,
  SERVICE_MONITOR_TTL_SECONDS,
  ServiceMonitorEvidenceSchema,
} from "@mongolgpt/console-core/service-monitor.js"
import { runServiceMonitor, runServiceMonitorCycle } from "../src/service-monitor"

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  })

const healthy = {
  "https://dev.mgpt.mn/api/health": json({ status: "ok", service: "console" }),
  "https://auth.dev.mgpt.mn/health": json({ status: "ok", service: "auth" }),
  "https://runtime.dev.mgpt.mn/global/health": json({
    healthy: true,
    service: "mongolgpt-runtime",
    stage: "dev",
    version: "0.1.1",
  }),
  "https://pay.dev.mgpt.mn/health": json({
    status: "disabled",
    service: "payments",
    environment: "disabled",
    providers: { qpay: false, bonum: false },
    catalog: false,
    checkout: false,
    cancellation: false,
    refund: false,
  }),
} satisfies Record<string, Response>

function responseFetcher(responses: Record<string, Response> = healthy) {
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    const response = responses[inputURL(input)]
    if (!response) throw new Error("unexpected URL")
    return response.clone()
  }
}

function inputURL(input: RequestInfo | URL) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

describe("Cloudflare service monitor", () => {
  test("checks every public service and stores bounded, expiring evidence", async () => {
    const writes: Array<[string, string, { expirationTtl: number }]> = []
    const evidence = await runServiceMonitor(
      { stage: "dev", stageDomain: "dev.mgpt.mn" },
      { put: async (...args) => void writes.push(args) },
      { fetcher: responseFetcher(), now: () => 1_800_000_000_000, timer: () => 100 },
    )

    expect(evidence.status).toBe("ok")
    expect(evidence.checks.map((check) => check.service)).toEqual(["console", "auth", "runtime", "payments"])
    expect(evidence.checks.every((check) => check.ok && check.httpStatus === 200)).toBe(true)
    expect(ServiceMonitorEvidenceSchema.safeParse(evidence).success).toBe(true)
    expect(writes).toEqual([
      [SERVICE_MONITOR_STATE_KEY, JSON.stringify(evidence), { expirationTtl: SERVICE_MONITOR_TTL_SECONDS }],
    ])
  })

  test("fails closed on HTTP, schema, content-type, and network errors without persisting response content", async () => {
    const responses = {
      ...healthy,
      "https://dev.mgpt.mn/api/health": json({ status: "ok", service: "console", token: "must-not-persist" }),
      "https://auth.dev.mgpt.mn/health": json({ status: "unavailable" }, 503),
      "https://pay.dev.mgpt.mn/health": new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    }
    const writes: string[] = []
    const base = responseFetcher(responses)
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (inputURL(input).includes("runtime.dev")) throw new Error("provider-secret-response")
      return base(input, init)
    }

    const evidence = await runServiceMonitor(
      { stage: "dev", stageDomain: "dev.mgpt.mn" },
      { put: async (_key, value) => void writes.push(value) },
      { fetcher, now: () => 1_800_000_000_000, timer: () => 100 },
    )

    expect(evidence.status).toBe("degraded")
    expect(Object.fromEntries(evidence.checks.map((check) => [check.service, check.failure]))).toEqual({
      console: "schema",
      auth: "http",
      runtime: "network",
      payments: "schema",
    })
    expect(writes.join("\n")).not.toContain("must-not-persist")
    expect(writes.join("\n")).not.toContain("provider-secret-response")
  })

  test("requires the runtime stage to match and classifies aborts as timeouts", async () => {
    const responses = {
      ...healthy,
      "https://runtime.dev.mgpt.mn/global/health": json({
        healthy: true,
        service: "mongolgpt-runtime",
        stage: "production",
        version: "0.1.1",
      }),
    }
    const base = responseFetcher(responses)
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (inputURL(input).includes("auth.dev")) throw new DOMException("timed out", "TimeoutError")
      return base(input, init)
    }
    const evidence = await runServiceMonitor(
      { stage: "dev", stageDomain: "dev.mgpt.mn" },
      { put: async () => undefined },
      { fetcher, now: () => 1_800_000_000_000, timer: () => 100 },
    )

    expect(evidence.checks.find((check) => check.service === "auth")?.failure).toBe("timeout")
    expect(evidence.checks.find((check) => check.service === "runtime")?.failure).toBe("schema")
  })

  test("rejects unsafe stage domains before making requests", async () => {
    let requested = false
    try {
      await runServiceMonitor(
        { stage: "dev", stageDomain: "mongolgpt.duckdns.org" },
        { put: async () => undefined },
        {
          fetcher: async () => {
            requested = true
            return json({})
          },
        },
      )
      throw new Error("monitor config should fail")
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError)
      expect(error instanceof Error ? error.message : "").toContain("domain")
    }
    expect(requested).toBe(false)
  })

  test("sends deduplicated Cloudflare Email alerts for incidents, changes, reminders, and recovery", async () => {
    const values = new Map<string, string>()
    const writes: Array<[string, string, { expirationTtl: number }]> = []
    const messages: Array<{ from: string; subject: string; text: string }> = []
    const state = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string, options: { expirationTtl: number }) => {
        values.set(key, value)
        writes.push([key, value, options])
      },
    }
    const email = {
      send: async (message: { from: string; subject: string; text: string }) => {
        messages.push(message)
        return { messageId: `message-${messages.length}` }
      },
    }
    let now = 1_800_000_000_000
    const config = { stage: "dev", stageDomain: "dev.mgpt.mn", alertFrom: "alerts@mgpt.mn" }
    const degradedAuth = {
      ...healthy,
      "https://auth.dev.mgpt.mn/health": json({ status: "unavailable" }, 503),
    }

    const opened = await runServiceMonitorCycle(config, state, email, {
      fetcher: responseFetcher(degradedAuth),
      now: () => now,
      timer: () => 100,
    })
    expect(opened.alert).toBe("opened")
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ from: "alerts@mgpt.mn" })
    expect(messages[0].subject).toContain("auth")
    expect(messages[0].text).toContain("HTTP 503")

    now += 5 * 60 * 1_000
    const duplicate = await runServiceMonitorCycle(config, state, email, {
      fetcher: responseFetcher(degradedAuth),
      now: () => now,
      timer: () => 100,
    })
    expect(duplicate.alert).toBe("none")
    expect(messages).toHaveLength(1)

    now += 5 * 60 * 1_000
    const changed = await runServiceMonitorCycle(config, state, email, {
      fetcher: async (input, init) => {
        if (inputURL(input).includes("runtime.dev")) throw new Error("secret-provider-body")
        return responseFetcher(degradedAuth)(input, init)
      },
      now: () => now,
      timer: () => 100,
    })
    expect(changed.alert).toBe("changed")
    expect(messages).toHaveLength(2)
    expect(messages[1].subject).toContain("runtime")
    expect(messages.map((message) => `${message.subject}\n${message.text}`).join("\n")).not.toContain(
      "secret-provider-body",
    )

    now += 61 * 60 * 1_000
    const reminder = await runServiceMonitorCycle(config, state, email, {
      fetcher: async (input, init) => {
        if (inputURL(input).includes("runtime.dev")) throw new Error("network")
        return responseFetcher(degradedAuth)(input, init)
      },
      now: () => now,
      timer: () => 100,
    })
    expect(reminder.alert).toBe("reminder")
    expect(messages).toHaveLength(3)

    now += 5 * 60 * 1_000
    const recovered = await runServiceMonitorCycle(config, state, email, {
      fetcher: responseFetcher(),
      now: () => now,
      timer: () => 100,
    })
    expect(recovered.alert).toBe("recovered")
    expect(messages).toHaveLength(4)
    expect(messages[3].subject).toContain("хэвийн боллоо")
    expect(writes.findLast(([key]) => key === SERVICE_MONITOR_ALERT_STATE_KEY)?.[2]).toEqual({
      expirationTtl: SERVICE_MONITOR_ALERT_STATE_TTL_SECONDS,
    })
  })

  test("records an alert attempt before email delivery so provider failures do not retry every cron run", async () => {
    const values = new Map<string, string>()
    const state = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        values.set(key, value)
      },
    }
    let attempts = 0
    const email = {
      send: async () => {
        attempts += 1
        throw new Error("provider-secret-response")
      },
    }
    let now = 1_800_000_000_000
    const config = { stage: "dev", stageDomain: "dev.mgpt.mn", alertFrom: "alerts@mgpt.mn" }
    const degraded = {
      ...healthy,
      "https://auth.dev.mgpt.mn/health": json({ status: "unavailable" }, 503),
    }

    let deliveryError: unknown
    try {
      await runServiceMonitorCycle(config, state, email, {
        fetcher: responseFetcher(degraded),
        now: () => now,
        timer: () => 100,
      })
    } catch (error) {
      deliveryError = error
    }
    expect(deliveryError).toBeInstanceOf(Error)
    expect(deliveryError instanceof Error ? deliveryError.message : "").toBe("provider-secret-response")
    expect(attempts).toBe(1)
    expect(values.get(SERVICE_MONITOR_ALERT_STATE_KEY)).not.toContain("provider-secret-response")

    now += 5 * 60 * 1_000
    const duplicate = await runServiceMonitorCycle(config, state, email, {
      fetcher: responseFetcher(degraded),
      now: () => now,
      timer: () => 100,
    })
    expect(duplicate.alert).toBe("none")
    expect(attempts).toBe(1)
  })

  test("ignores stale alert state instead of emitting a false recovery or reminder", async () => {
    const now = 1_800_000_000_000
    const staleState = JSON.stringify({
      version: 1,
      stage: "dev",
      status: "degraded",
      fingerprint: "auth:http:503",
      recordedAt: now - SERVICE_MONITOR_ALERT_STATE_MAX_AGE_MS - 1,
    })
    const config = { stage: "dev", stageDomain: "dev.mgpt.mn", alertFrom: "alerts@mgpt.mn" }

    const healthyValues = new Map([[SERVICE_MONITOR_ALERT_STATE_KEY, staleState]])
    const healthyMessages: unknown[] = []
    const healthyResult = await runServiceMonitorCycle(
      config,
      {
        get: async (key) => healthyValues.get(key) ?? null,
        put: async (key, value) => healthyValues.set(key, value),
      },
      { send: async (message) => healthyMessages.push(message) },
      { fetcher: responseFetcher(), now: () => now, timer: () => 100 },
    )
    expect(healthyResult.alert).toBe("none")
    expect(healthyMessages).toHaveLength(0)

    const degradedValues = new Map([[SERVICE_MONITOR_ALERT_STATE_KEY, staleState]])
    const degradedMessages: unknown[] = []
    const degradedResult = await runServiceMonitorCycle(
      config,
      {
        get: async (key) => degradedValues.get(key) ?? null,
        put: async (key, value) => degradedValues.set(key, value),
      },
      { send: async (message) => degradedMessages.push(message) },
      {
        fetcher: responseFetcher({
          ...healthy,
          "https://auth.dev.mgpt.mn/health": json({ status: "unavailable" }, 503),
        }),
        now: () => now,
        timer: () => 100,
      },
    )
    expect(degradedResult.alert).toBe("opened")
    expect(degradedMessages).toHaveLength(1)
  })
})
