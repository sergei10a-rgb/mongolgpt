import { describe, expect, test } from "bun:test"
import { cleanupEmptyCanary } from "../script/cleanup-empty-canary"
import type { CanaryRequest } from "../script/canary-resources"

const input = {
  accountID: "0123456789abcdef0123456789abcdef",
  token: "test-token-never-sent-to-cloudflare",
  runID: "34265870180",
  attempt: "1",
  databaseID: "11111111-2222-4333-8444-555555555555",
  containerApplicationID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
}
const name = `mgpt-canary-${input.runID}-${input.attempt}`
const namespace = "99999999-8888-4777-9666-555555555555"

describe("empty canary recovery", () => {
  test("rejects malformed resource identifiers before any network access", async () => {
    for (const override of [
      { runID: "mongolgpt-runtime-dev" },
      { attempt: "../1" },
      { databaseID: "" },
      { databaseID: "../live" },
      { containerApplicationID: "" },
      { accountID: "../live" },
      { token: "" },
    ]) {
      const api = mock()
      await expect(cleanupEmptyCanary({ ...input, ...override, request: api.request })).rejects.toThrow()
      expect(api.calls).toEqual([])
    }
  })

  test("removes only exact owned resources after verified empty instance listing", async () => {
    const api = mock()
    const result = await cleanupEmptyCanary({ ...input, request: api.request })
    expect(result.failures).toEqual([])
    expect(result.manualCleanup).toEqual([])
    expect(result.deleted).toEqual([
      `worker:${name}`,
      `container:${input.containerApplicationID}`,
      `r2:${name}`,
      `d1:${input.databaseID}`,
    ])
    expect(api.calls[0]).toBe(
      `GET /accounts/${input.accountID}/containers/dash/applications/${input.containerApplicationID}/instances?per_page=1`,
    )
    expect(api.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE /accounts/${input.accountID}/workers/scripts/${name}`,
      `DELETE /accounts/${input.accountID}/containers/applications/${input.containerApplicationID}`,
      `DELETE /accounts/${input.accountID}/r2/buckets/${name}`,
      `DELETE /accounts/${input.accountID}/d1/database/${input.databaseID}`,
    ])
    expect(api.calls.some((call) => /force|mongolgpt-runtime-dev/.test(call))).toBe(false)
  })

  test("retains all resources for active, historical, paginated, or unverified instances", async () => {
    for (const listing of [
      {},
      { success: false, result: { instances: [] } },
      { result: { instances: [] } },
      { success: true, result: { instances: [{}] } },
      { success: true, result: { instances: [], durable_objects: [{}] } },
      { success: true, result: { instances: [], durable_objects: {} } },
      { success: true, result: { instances: [] }, result_info: { next_page_token: "next" } },
    ]) {
      const api = mock({ listing })
      const result = await cleanupEmptyCanary({ ...input, request: api.request })
      expect(result.failures.length).toBeGreaterThan(0)
      expect(result.deleted).toEqual([])
      expect(api.calls.filter((call) => call.startsWith("DELETE"))).toEqual([])
    }
  })

  test("empty instances never override namespace ownership or a failed bucket delete", async () => {
    const mismatched = mock({ namespace: "88888888-8888-4777-9666-555555555555" })
    const rejected = await cleanupEmptyCanary({ ...input, request: mismatched.request })
    expect(rejected.failures.length).toBeGreaterThan(0)
    expect(rejected.deleted).toEqual([])
    const nonempty = mock({ bucketStatus: 409 })
    const retained = await cleanupEmptyCanary({ ...input, request: nonempty.request })
    expect(retained.deleted).toEqual([`worker:${name}`, `container:${input.containerApplicationID}`])
    expect(retained.failures[0]?.resource).toBe(`r2:${name}`)
    expect(retained.manualCleanup).toContain(`d1:${input.databaseID}`)
    expect(nonempty.calls.filter((call) => call.startsWith("DELETE") && call.includes("/d1/"))).toEqual([])
  })

  test("HTTP and network failures do not leak credentials or delete anything", async () => {
    for (const error of [false, true]) {
      const api = mock({ listingError: error ? input.token : undefined, listingStatus: 403 })
      const result = await cleanupEmptyCanary({ ...input, request: api.request })
      expect(result.deleted).toEqual([])
      expect(result.failures.length).toBeGreaterThan(0)
      expect(JSON.stringify(result)).not.toContain(input.token)
    }
  })

  test("workflow is confirmed, owner-only, main-only, protected, and serialized with canaries", async () => {
    const workflow = await Bun.file(
      new URL("../../../.github/workflows/cleanup-empty-canary.yml", import.meta.url),
    ).text()
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("CLEAN EMPTY CANARY")
    expect(workflow).toContain("github.repository == 'sergei10a-rgb/mongolgpt'")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain("environment: dev")
    expect(workflow).toContain("group: cloudflare-isolated-canary")
    expect(workflow).toContain("cancel-in-progress: false")
    expect(workflow).toContain("contents: read")
    expect(workflow).not.toContain("pull_request")
    const script = await Bun.file(new URL("../script/cleanup-empty-canary.ts", import.meta.url)).text()
    expect(script).toContain('process.env.CANARY_CLEANUP_CONFIRMATION !== "CLEAN EMPTY CANARY"')
  })
})

function mock(
  options: {
    listing?: unknown
    namespace?: string
    bucketStatus?: number
    listingStatus?: number
    listingError?: string
  } = {},
) {
  const calls: string[] = []
  const request: CanaryRequest = async (url, init) => {
    const path = new URL(url).pathname.replace("/client/v4", "") + new URL(url).search
    const method = init?.method ?? "GET"
    calls.push(`${method} ${path}`)
    expect(init?.redirect).toBe("error")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${input.token}`)
    if (path.endsWith("/instances?per_page=1")) {
      if (options.listingError) throw new Error(options.listingError)
      return Response.json(options.listing ?? { success: true, result: { instances: [], durable_objects: [] } }, {
        status: options.listingStatus ?? 200,
      })
    }
    if (method === "DELETE") {
      if (path.includes("/r2/") && options.bucketStatus)
        return Response.json({ success: false }, { status: options.bucketStatus })
      if (path.includes("/containers/")) return new Response(null, { status: 204 })
      return Response.json({ success: true, result: {} })
    }
    if (path.endsWith("/settings"))
      return Response.json({
        success: true,
        result: {
          bindings: [
            { type: "d1", name: "HISTORY", id: input.databaseID },
            { type: "r2_bucket", name: "RUNTIME_BACKUPS", bucket_name: name },
            { type: "durable_object_namespace", name: "Sandbox", class_name: "CanarySandbox", namespace_id: namespace },
          ],
        },
      })
    if (path.includes("/containers/applications/"))
      return Response.json({
        id: input.containerApplicationID,
        name,
        durable_objects: { namespace_id: options.namespace ?? namespace },
      })
    if (path.includes("/d1/database/") || path.includes("/r2/buckets/"))
      return Response.json({ success: true, result: { name } })
    throw new Error("Unexpected request")
  }
  return { request, calls }
}
