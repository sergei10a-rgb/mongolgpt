import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { Schema } from "effect"
import { deriveRuntimeIdentity } from "../src/runtime"
import { readCanaryJson } from "./canary-probe"

const accountID = "cc97ad90bfaf8a1da5de612eef2658f5"
const databaseID = "d8930539-cb16-4613-9acc-9313c8f15ff3"
const namespaceID = "ceb126c25207461582b78289fb6bc9d3"
const worker = "mongolgpt-runtime-dev"
const base = `https://api.cloudflare.com/client/v4/accounts/${accountID}`
const Scope = Schema.Struct({
  account_id: Schema.String.check(Schema.isPattern(/^acc_[0-9A-Z]{26}$/)),
  workspace_id: Schema.String.check(Schema.isPattern(/^wrk_[0-9A-Z]{26}$/)),
  inactive: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
})
const Objects = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      hasStoredData: Schema.Boolean,
    }),
  ),
  result_info: Schema.optional(Schema.Struct({ cursor: Schema.optional(Schema.NullOr(Schema.String)) })),
})

// Include inactive and orphaned memberships: they can still own legacy data.
// Do not select emails, names, messages, keys, or any user content.
export const devRuntimeScopeQuery = `SELECT u.account_id, u.workspace_id,
CASE WHEN u.time_deleted IS NOT NULL OR w.id IS NULL OR w.time_deleted IS NOT NULL THEN 1 ELSE 0 END AS inactive
FROM user u LEFT JOIN workspace w ON w.id = u.workspace_id
WHERE u.account_id IS NOT NULL
ORDER BY u.account_id, u.workspace_id LIMIT 101`

export function devRuntimeInventoryContext(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.MONGOLGPT_INVENTORY_CONFIRMATION !== "INSPECT DEV RUNTIME" ||
    env.CLOUDFLARE_ACCOUNT_ID !== accountID ||
    !env.CLOUDFLARE_API_TOKEN?.trim() ||
    (env.MONGOLGPT_RUNTIME_SECRET?.trim().length ?? 0) < 32 ||
    !isAbsolute(env.RUNNER_TEMP ?? "")
  )
    throw new Error("Dev runtime inventory context rejected")
  return { accountID, databaseID, namespaceID, worker }
}

export async function inventoryDevRuntime(
  env: NodeJS.ProcessEnv,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const identity = devRuntimeInventoryContext(env)
  const read = async (path: string, body?: { sql: string }) => {
    const signal = AbortSignal.timeout(15_000)
    const response = await request(`${base}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal,
    })
    return readCanaryJson(response, signal)
  }
  const database = Schema.decodeUnknownSync(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Struct({
        uuid: Schema.Literal(databaseID),
        name: Schema.Literal("mongolgpt-dev-databasedatabase-kwsftfax"),
      }),
    }),
  )(await read(`d1/database/${databaseID}`))
  const settings = Schema.decodeUnknownSync(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Struct({
        bindings: Schema.Array(
          Schema.Struct({ name: Schema.String, type: Schema.String, namespace_id: Schema.optional(Schema.String) }),
        ),
      }),
    }),
  )(await read(`workers/scripts/${worker}/settings`))
  const sandbox = settings.result.bindings.filter((binding) => binding.name === "Sandbox")
  if (
    sandbox.length !== 1 ||
    sandbox[0].type !== "durable_object_namespace" ||
    sandbox[0].namespace_id !== namespaceID ||
    settings.result.bindings.some((binding) => ["HISTORY", "RUNTIME_BACKUPS"].includes(binding.name))
  )
    throw new Error("Legacy runtime binding changed; inventory stopped")

  const query = Schema.decodeUnknownSync(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Array(
        Schema.Struct({
          success: Schema.Literal(true),
          results: Schema.Array(Scope),
          meta: Schema.Struct({ changed_db: Schema.Literal(false), rows_written: Schema.Literal(0) }),
        }),
      ),
    }),
  )(await read(`d1/database/${database.result.uuid}/query`, { sql: devRuntimeScopeQuery }))
  if (query.result.length !== 1 || query.result[0].results.length > 100)
    throw new Error("Legacy scope inventory exceeded its bounded result")
  const scopes: Array<{ scopeHash: string; sandboxID: string; inactive: boolean }> = []
  for (const row of query.result[0].results) {
    const scopeHash = createHash("sha256")
      .update(JSON.stringify([row.account_id, row.workspace_id]))
      .digest("hex")
    if (scopes.some((scope) => scope.scopeHash === scopeHash)) throw new Error("Duplicate legacy scope")
    const runtime = await deriveRuntimeIdentity(row.account_id, row.workspace_id, env.MONGOLGPT_RUNTIME_SECRET!)
    scopes.push({ scopeHash, sandboxID: runtime.sandboxID, inactive: row.inactive === 1 })
  }

  const objects: Array<{ id: string; hasStoredData: boolean }> = []
  const cursors = new Set<string>()
  let cursor = ""
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) })
    const result = Schema.decodeUnknownSync(Objects)(
      await read(`workers/durable_objects/namespaces/${namespaceID}/objects?${params}`),
    )
    if (result.result.length > 100) throw new Error("Legacy object page exceeded its bound")
    for (const object of result.result) {
      if (objects.some((existing) => existing.id === object.id)) throw new Error("Duplicate legacy object")
      objects.push({ id: object.id, hasStoredData: object.hasStoredData })
    }
    cursor = result.result_info?.cursor ?? ""
    if (!cursor)
      return { stage: "dev", ...identity, scopes, objects, quiesced: false, cutoverReady: false, workerDeployed: false }
    if (cursor.length > 4096 || cursors.has(cursor)) throw new Error("Legacy object cursor invalid")
    cursors.add(cursor)
  }
  throw new Error("Legacy object inventory exceeded its bounded pages")
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error("Unexpected inventory argument")
    const receipt = await inventoryDevRuntime(process.env)
    await Bun.write(join(process.env.RUNNER_TEMP!, "dev-runtime-inventory.json"), JSON.stringify(receipt, null, 2))
    console.log(`Dev runtime inventory: ${receipt.scopes.length} scopes, ${receipt.objects.length} objects. No writes.`)
  } catch {
    console.error("Dev runtime inventory failed. No credentials, account IDs or private API responses were printed.")
    process.exitCode = 1
  }
}
