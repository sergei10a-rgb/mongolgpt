import { describe, expect, test } from "bun:test"
import {
  SERVICE_MONITOR_STATE_KEY,
  SERVICE_MONITOR_TTL_SECONDS,
  ServiceMonitorEvidenceSchema,
} from "@mongolgpt/console-core/service-monitor.js"
import { runServiceMonitor } from "../src/service-monitor"

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
})
