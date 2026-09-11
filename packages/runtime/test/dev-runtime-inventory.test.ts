import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { devRuntimeInventoryContext, devRuntimeScopeQuery, inventoryDevRuntime } from "../script/inventory-dev-runtime"
import { deriveRuntimeIdentity } from "../src/runtime"

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
  GITHUB_REF: "refs/heads/main",
  MONGOLGPT_INVENTORY_CONFIRMATION: "INSPECT DEV RUNTIME",
  CLOUDFLARE_ACCOUNT_ID: "cc97ad90bfaf8a1da5de612eef2658f5",
  CLOUDFLARE_API_TOKEN: "synthetic-inventory-token",
  MONGOLGPT_RUNTIME_SECRET: "synthetic-inventory-runtime-secret",
  RUNNER_TEMP: process.cwd(),
}
const identity = devRuntimeInventoryContext(env)
const account = `acc_${"A".repeat(26)}`
const workspace = `wrk_${"B".repeat(26)}`
const row = { account_id: account, workspace_id: workspace, inactive: 0 }

function api(overrides: { settings?: unknown; query?: unknown; pages?: unknown[]; response?: Response } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  let page = 0
  const request = async (url: string, init: RequestInit) => {
    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://api.cloudflare.com")
    expect(init.redirect).toBe("error")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${env.CLOUDFLARE_API_TOKEN}`)
    const path = parsed.pathname.replace(`/client/v4/accounts/${identity.accountID}/`, "")
    calls.push({
      path: path + parsed.search,
      method: init.method!,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    })
    if (overrides.response) return overrides.response
    if (path === `d1/database/${identity.databaseID}`)
      return Response.json({
        success: true,
        result: { uuid: identity.databaseID, name: "mongolgpt-dev-databasedatabase-kwsftfax" },
      })
    if (path === `workers/scripts/${identity.worker}/settings`)
      return Response.json(
        overrides.settings ?? {
          success: true,
          result: {
            bindings: [{ name: "Sandbox", type: "durable_object_namespace", namespace_id: identity.namespaceID }],
          },
        },
      )
    if (path === `d1/database/${identity.databaseID}/query`)
      return Response.json(
        overrides.query ?? {
          success: true,
          result: [{ success: true, results: [row], meta: { changed_db: false, rows_written: 0 } }],
        },
      )
    if (path === `workers/durable_objects/namespaces/${identity.namespaceID}/objects`)
      return Response.json(overrides.pages?.[page++] ?? { success: true, result: [] })
    throw new Error("Unexpected inventory endpoint")
  }
  return { calls, request }
}

test("inventory rejects unconfirmed, foreign and incomplete execution contexts before I/O", async () => {
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "anomalyco/opencode" },
    { GITHUB_REF: "refs/heads/production" },
    { MONGOLGPT_INVENTORY_CONFIRMATION: "DEPLOY" },
    { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) },
    { CLOUDFLARE_API_TOKEN: "" },
    { MONGOLGPT_RUNTIME_SECRET: "short" },
    { RUNNER_TEMP: "relative" },
  ]) {
    const fixture = api()
    await expect(inventoryDevRuntime({ ...env, ...change }, fixture.request)).rejects.toThrow()
    expect(fixture.calls).toEqual([])
  }
})

test("inventory uses the real scope derivation but never emits passwords or account identifiers", async () => {
  const fixture = api()
  const receipt = await inventoryDevRuntime(env, fixture.request)
  const derived = await deriveRuntimeIdentity(account, workspace, env.MONGOLGPT_RUNTIME_SECRET)
  expect(receipt.scopes).toEqual([
    {
      scopeHash: createHash("sha256")
        .update(JSON.stringify([account, workspace]))
        .digest("hex"),
      sandboxID: derived.sandboxID,
      inactive: false,
    },
  ])
  expect(receipt.objects).toEqual([])
  expect(receipt.quiesced).toBe(false)
  expect(receipt.cutoverReady).toBe(false)
  expect(receipt.workerDeployed).toBe(false)
  for (const privateValue of [
    account,
    workspace,
    env.CLOUDFLARE_API_TOKEN,
    env.MONGOLGPT_RUNTIME_SECRET,
    derived.password,
  ])
    expect(JSON.stringify(receipt)).not.toContain(privateValue)
  expect(fixture.calls).toEqual([
    { path: `d1/database/${identity.databaseID}`, method: "GET" },
    { path: `workers/scripts/${identity.worker}/settings`, method: "GET" },
    { path: `d1/database/${identity.databaseID}/query`, method: "POST", body: { sql: devRuntimeScopeQuery } },
    { path: `workers/durable_objects/namespaces/${identity.namespaceID}/objects?limit=100`, method: "GET" },
  ])
})

test("scope SELECT includes inactive and orphaned scopes and does not mutate SQLite", () => {
  using db = new Database(":memory:")
  db.exec(`CREATE TABLE workspace (id TEXT, time_deleted TEXT);
CREATE TABLE user (account_id TEXT, workspace_id TEXT, time_deleted TEXT, email TEXT);
INSERT INTO workspace VALUES ('active', NULL), ('deleted', 'yesterday');
INSERT INTO user VALUES ('a','active',NULL,'private@example.invalid'), ('b','deleted',NULL,'private'),
('c','missing',NULL,'private'), ('d','active','yesterday','private'), (NULL,'active',NULL,'private');`)
  const before = db.query("SELECT total_changes() AS changes").get()
  expect(db.query(devRuntimeScopeQuery).all()).toEqual([
    { account_id: "a", workspace_id: "active", inactive: 0 },
    { account_id: "b", workspace_id: "deleted", inactive: 1 },
    { account_id: "c", workspace_id: "missing", inactive: 1 },
    { account_id: "d", workspace_id: "active", inactive: 1 },
  ])
  expect(db.query("SELECT total_changes() AS changes").get()).toEqual(before)
  expect(devRuntimeScopeQuery).not.toMatch(/email|token|password|SELECT\s+\*/i)
})

test("changed Worker bindings and bad database metadata stop before scope queries", async () => {
  for (const bindings of [
    [],
    [{ name: "Sandbox", type: "durable_object_namespace", namespace_id: "foreign" }],
    [{ name: "Sandbox", type: "plain_text", namespace_id: identity.namespaceID }],
    [
      { name: "Sandbox", type: "durable_object_namespace", namespace_id: identity.namespaceID },
      { name: "HISTORY", type: "d1" },
    ],
  ]) {
    const fixture = api({ settings: { success: true, result: { bindings } } })
    await expect(inventoryDevRuntime(env, fixture.request)).rejects.toThrow()
    expect(fixture.calls).toHaveLength(2)
  }
  const fixture = api({ response: Response.json({ success: true, result: { uuid: "foreign", name: "console" } }) })
  await expect(inventoryDevRuntime(env, fixture.request)).rejects.toThrow()
  expect(fixture.calls).toHaveLength(1)
})

test("scope query rejects partial, duplicate, oversized, malformed and write receipts", async () => {
  for (const result of [
    [],
    [{ success: false, results: [row], meta: { changed_db: false, rows_written: 0 } }],
    ...[[row, row], Array(101).fill(row), [{ ...row, account_id: "foreign" }]]
      .map((results) => ({
        success: true,
        results,
        meta: { changed_db: false, rows_written: 0 },
      }))
      .map((value) => [value]),
    [{ success: true, results: [row], meta: { changed_db: true, rows_written: 0 } }],
    [{ success: true, results: [row], meta: { changed_db: false, rows_written: 1 } }],
  ]) {
    const fixture = api({ query: { success: true, result } })
    await expect(inventoryDevRuntime(env, fixture.request)).rejects.toThrow()
    expect(fixture.calls).toHaveLength(3)
  }
})

test("object pagination preserves stored-data evidence and never treats an incomplete list as complete", async () => {
  const object = { id: "a".repeat(64), hasStoredData: true }
  const page = { success: true, result: [object], result_info: { cursor: "next/+?" } }
  const fixture = api({
    pages: [page, { success: true, result: [{ ...object, id: "b".repeat(64), hasStoredData: false }] }],
  })
  const receipt = await inventoryDevRuntime(env, fixture.request)
  expect(receipt.objects).toEqual([object, { id: "b".repeat(64), hasStoredData: false }])
  expect(fixture.calls[4].path).toEndWith("?limit=100&cursor=next%2F%2B%3F")
  for (const pages of [
    [page, page],
    [{ success: true, result: [{ id: object.id }] }],
    [{ success: true, result: Array(101).fill(object) }],
    [{ success: true, result: [], result_info: { cursor: "x".repeat(4097) } }],
    Array.from({ length: 10 }, (_, index) => ({
      success: true,
      result: [],
      result_info: { cursor: String(index + 1) },
    })),
  ])
    await expect(inventoryDevRuntime(env, api({ pages }).request)).rejects.toThrow()
})

test("failed and oversized private API responses cannot become receipts", async () => {
  for (const response of [
    new Response("private response", { status: 403 }),
    new Response("html", { headers: { "content-type": "text/html" } }),
    new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }),
  ])
    await expect(inventoryDevRuntime(env, api({ response }).request)).rejects.toThrow()
})

test("workflow is owner/main/dev, manual only and has no deployment or user auth secrets", async () => {
  const source = await Bun.file(new URL("../../../.github/workflows/inspect-dev-runtime.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>
    concurrency: unknown
    permissions: unknown
    jobs: { inspect: { if: string; environment: string; steps: Array<{ run?: string }> } }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.jobs.inspect.environment).toBe("dev")
  expect(workflow.jobs.inspect.if).toBe(
    "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
  )
  expect(workflow.jobs.inspect.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
    'test "$CONFIRMATION" = "INSPECT DEV RUNTIME"',
    "bun --cwd packages/runtime test test/dev-runtime-inventory.test.ts",
    "bun packages/runtime/script/inventory-dev-runtime.ts",
  ])
  expect(source).not.toContain("MONGOLGPT_RUNTIME_AUTH_SECRET")
  expect(source).not.toContain("wrangler")
})
