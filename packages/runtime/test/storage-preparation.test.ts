import { expect, test } from "bun:test"
import {
  storageMigrationCommand,
  storagePreparationContext,
  verifyStorageIdentity,
  verifyStorageMigrations,
} from "../script/prepare-storage"
import config from "../wrangler.storage.dev.json"

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
  GITHUB_REF: "refs/heads/main",
  MONGOLGPT_STORAGE_CONFIRMATION: "PREPARE DEV RUNTIME STORAGE",
  CLOUDFLARE_ACCOUNT_ID: config.account_id,
  CLOUDFLARE_API_TOKEN: "synthetic-storage-token",
  RUNNER_TEMP: process.cwd(),
}

test("storage preparation is limited to the confirmed owner dev environment", () => {
  expect(storagePreparationContext(env).databaseID).toBe("8415178b-8e73-46ae-947a-215eaf42d9b5")
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "anomalyco/opencode" },
    { GITHUB_REF: "refs/heads/production" },
    { MONGOLGPT_STORAGE_CONFIRMATION: "deploy" },
    { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) },
    { CLOUDFLARE_API_TOKEN: "" },
    { RUNNER_TEMP: "relative" },
  ])
    expect(() => storagePreparationContext({ ...env, ...change })).toThrow()
})

test("storage config has no Worker entrypoint, routes, containers or activation flags", () => {
  expect(config.account_id).toBe("cc97ad90bfaf8a1da5de612eef2658f5")
  expect(Object.keys(config).sort()).toEqual(["$schema", "account_id", "d1_databases", "name", "r2_buckets"])
  expect(config.d1_databases).toEqual([
    {
      binding: "HISTORY",
      database_name: "mongolgpt-runtime-history-dev",
      database_id: "8415178b-8e73-46ae-947a-215eaf42d9b5",
      migrations_dir: "migrations",
    },
  ])
  expect(config.r2_buckets).toEqual([{ binding: "RUNTIME_BACKUPS", bucket_name: "mongolgpt-runtime-backups-dev" }])
  expect(storageMigrationCommand("apply", "bun")).toEqual([
    "bun",
    "x",
    "--no-install",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "HISTORY",
    "--remote",
    "--config=wrangler.storage.dev.json",
  ])
  expect(storageMigrationCommand("verify", "bun")).toEqual([
    "bun",
    "x",
    "--no-install",
    "wrangler",
    "d1",
    "execute",
    "HISTORY",
    "--remote",
    "--config=wrangler.storage.dev.json",
    "--command=SELECT name FROM d1_migrations ORDER BY name",
    "--json",
  ])
})

test("migration receipts must confirm every current migration exactly once", () => {
  const expected = ["0001_history.sql", "0002_history_checkpoint.sql"]
  const receipt = (names: unknown[]) => [{ success: true, results: names.map((name) => ({ name })) }]
  expect(verifyStorageMigrations(receipt(expected), expected)).toEqual(expected)
  for (const input of [
    null,
    {},
    [],
    [{ success: false }],
    receipt([expected[0]]),
    receipt([...expected, expected[0]]),
    receipt([...expected, "unknown.sql"]),
    receipt([42]),
    receipt([...expected].reverse()),
  ])
    expect(() => verifyStorageMigrations(input, expected)).toThrow()
  expect(() => verifyStorageMigrations(receipt([]), [])).toThrow()
})

test("metadata checks perform only two exact authenticated reads and reject foreign resources", async () => {
  const calls: string[] = []
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url))
    expect(init?.method).toBeUndefined()
    expect(init?.redirect).toBe("error")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-storage-token")
    return Response.json({
      success: true,
      result:
        calls.length === 1
          ? { name: "mongolgpt-runtime-history-dev", uuid: "8415178b-8e73-46ae-947a-215eaf42d9b5" }
          : { name: "mongolgpt-runtime-backups-dev" },
    })
  }
  await verifyStorageIdentity(env.CLOUDFLARE_API_TOKEN, request)
  expect(calls).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/8415178b-8e73-46ae-947a-215eaf42d9b5`,
    `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/mongolgpt-runtime-backups-dev`,
  ])
  for (const response of [
    Response.json({ success: true, result: { name: "console", uuid: config.d1_databases[0].database_id } }),
    Response.json({ success: true, result: { name: "mongolgpt-runtime-history-dev", uuid: "wrong" } }),
    Response.json({ success: false }),
    new Response("private failure", { status: 403 }),
    new Response("x".repeat(32769), { headers: { "content-type": "application/json" } }),
  ])
    await expect(verifyStorageIdentity("test", async () => response)).rejects.toThrow()
})

test("storage workflow cannot deploy a Worker or automatically run on push", async () => {
  const source = await Bun.file(
    new URL("../../../.github/workflows/prepare-dev-runtime-storage.yml", import.meta.url),
  ).text()
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>
    concurrency: unknown
    permissions: unknown
    jobs: {
      prepare: {
        if: string
        environment: string
        steps: Array<{ run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }>
      }
    }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.jobs.prepare.environment).toBe("dev")
  const node = workflow.jobs.prepare.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"))
  const bun = workflow.jobs.prepare.steps.findIndex((step) => step.uses === "./.github/actions/setup-bun")
  expect(node).toBeGreaterThanOrEqual(0)
  expect(node).toBeLessThan(bun)
  expect(workflow.jobs.prepare.steps[node].with).toEqual({ "node-version": "24" })
  expect(workflow.jobs.prepare.if).toBe(
    "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
  )
  expect(workflow.jobs.prepare.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
    'test "$CONFIRMATION" = "PREPARE DEV RUNTIME STORAGE"',
    "bun --cwd packages/runtime test test/storage-preparation.test.ts",
    "bun packages/runtime/script/prepare-storage.ts",
  ])
  expect(source).not.toContain("MONGOLGPT_RUNTIME_SECRET")
  expect(source).not.toContain("MONGOLGPT_RUNTIME_AUTH_SECRET")
})
