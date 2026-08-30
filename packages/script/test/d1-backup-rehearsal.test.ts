import { describe, expect, test } from "bun:test"
import path from "node:path"
import { executeD1BackupRehearsal, type D1BackupRehearsalConfig } from "../src/d1-backup-rehearsal"

const config: D1BackupRehearsalConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  workflowName: "mongolgpt-dev-d1backupworkflowworkflow",
  apiToken: "deploy-secret-token",
  stage: "dev",
  runId: "33223711547",
}
const instanceId = "mongolgpt-dev-backup-33223711547-01234567-89ab-cdef-0123-456789abcdef"

function json(result: unknown, status = 200) {
  return Response.json({ success: status >= 200 && status < 300, result, errors: [] }, { status })
}

function inputURL(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

async function expectRejection(promise: Promise<unknown>, text: string) {
  const error = await promise.catch((value) => value)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : "").toContain(text)
}

describe("D1 backup rehearsal", () => {
  test("creates one dev workflow instance, polls to completion, and returns a bounded receipt", async () => {
    const calls: Array<{
      url: string
      method: string
      authorization: string | null
      body?: unknown
      redirect?: RequestRedirect
      hasSignal: boolean
    }> = []
    const statuses = ["queued", "running", "complete"]
    const receipt = await executeD1BackupRehearsal(config, {
      instanceId,
      now: () => new Date("2026-08-30T00:20:00.000Z"),
      sleep: async () => undefined,
      pollDelayMs: 0,
      fetcher: async (input, init) => {
        const method = init?.method ?? "GET"
        calls.push({
          url: inputURL(input),
          method,
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          redirect: init?.redirect,
          hasSignal: init?.signal instanceof AbortSignal,
        })
        if (method === "POST") return json({ id: instanceId, status: "queued" })
        return json({ id: instanceId, status: statuses.shift() })
      },
    })

    expect(calls).toHaveLength(4)
    expect(calls.every((call) => call.authorization === `Bearer ${config.apiToken}`)).toBe(true)
    expect(calls.every((call) => call.redirect === "error" && call.hasSignal)).toBe(true)
    expect(calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workflows/${config.workflowName}/instances`,
    )
    expect(calls[0]?.body).toEqual({
      instance_id: instanceId,
      instance_retention: { success_retention: "30 days", error_retention: "30 days" },
      params: JSON.stringify({ scheduledTime: Date.parse("2026-08-30T00:20:00.000Z") }),
    })
    expect(receipt).toEqual({
      version: 1,
      kind: "mongolgpt-d1-backup-rehearsal",
      stage: "dev",
      workflowName: config.workflowName,
      instanceId,
      scheduledTime: "2026-08-30T00:20:00.000Z",
      completedAt: "2026-08-30T00:20:00.000Z",
    })
  })

  test("fails closed for non-dev, foreign instance IDs, terminal errors, and timeouts", async () => {
    const invalidStage = structuredClone(config)
    Reflect.set(invalidStage, "stage", "production")
    await expectRejection(executeD1BackupRehearsal(invalidStage, { instanceId }), "зөвхөн dev")
    await expectRejection(
      executeD1BackupRehearsal(config, {
        instanceId,
        fetcher: async () => json({ id: "foreign-instance", status: "queued" }),
      }),
      "өөр instance ID",
    )
    await expectRejection(
      executeD1BackupRehearsal(config, {
        instanceId,
        fetcher: async (_input, init) =>
          json({ id: instanceId, status: init?.method === "POST" ? "queued" : "errored" }),
      }),
      "errored",
    )
    await expectRejection(
      executeD1BackupRehearsal(config, {
        instanceId,
        pollAttempts: 2,
        pollDelayMs: 0,
        sleep: async () => undefined,
        fetcher: async () => json({ id: instanceId, status: "running" }),
      }),
      "30 минутын дотор",
    )
  })

  test("rejects oversized and non-JSON Cloudflare responses without exposing tokens", async () => {
    const oversized = new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } })
    await expectRejection(executeD1BackupRehearsal(config, { instanceId, fetcher: async () => oversized }), "хэт том")
    await expectRejection(
      executeD1BackupRehearsal(config, {
        instanceId,
        fetcher: async () => new Response(new Uint8Array(1024 * 1024 + 1)),
      }),
      "хэт том",
    )
    const error = await executeD1BackupRehearsal(config, {
      instanceId,
      fetcher: async () => new Response("not-json", { status: 502 }),
    }).catch((value) => value)
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").not.toContain(config.apiToken)
  })

  test("operator script is dev-only and writes a receipt without logging secrets", async () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const source = await Bun.file(path.join(root, "script/d1-backup-rehearsal.ts")).text()
    expect(source).toContain('linkedResource("D1BackupWorkflow")')
    expect(source).toContain('stage !== "dev"')
    expect(source).toContain('option("--receipt")')
    expect(source).not.toContain("console.log(apiToken")
    expect(source).not.toContain("JSON.stringify(process.env")
  })
})
