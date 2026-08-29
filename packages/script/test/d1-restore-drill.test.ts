import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  buildD1RestoreDrillChildEnvironment,
  executeD1RestoreDrill,
  type D1RestoreDrillConfig,
  type MaterializedD1Backup,
} from "../src/d1-restore-drill"

const config: D1RestoreDrillConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  sourceDatabaseId: "01234567-89ab-cdef-0123-456789abcdef",
  backupBucket: "mongolgpt-dev-d1-backups",
  apiToken: "restore-drill-secret-token",
  stage: "dev",
  runId: "33223711547",
}
const createdAt = "2026-08-29T00:20:00.000Z"
const sql = "-- backup\n"
const artifactKey = "d1/dev/2026/08/29/2026-08-29T00-20-00.000Z-mongolgpt.sql"
const manifest = {
  version: 1,
  kind: "mongolgpt-d1-backup",
  source: "cloudflare-d1-export",
  stage: "dev",
  databaseId: config.sourceDatabaseId,
  bookmark: "bookmark-2026-08-29",
  createdAt,
  artifact: {
    key: artifactKey,
    size: new TextEncoder().encode(sql).byteLength,
    etag: "backup-etag",
    contentType: "application/sql",
  },
} as const
const manifestBody = JSON.stringify(manifest)
const drillDatabaseId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

function json(result: unknown, extra: Record<string, unknown> = {}) {
  return Response.json({ success: true, result, errors: [], ...extra })
}

function inputURL(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

async function expectRejection(promise: Promise<unknown>, text: string) {
  const error = await promise.catch((value) => value)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : "").toContain(text)
  return error
}

function successfulFetcher(calls: Array<{ url: string; method: string }>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = inputURL(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.apiToken}`)
    if (url.includes("/r2/buckets/") && url.includes("/objects?")) {
      return json([
        {
          key: `${artifactKey}.manifest.json`,
          size: new TextEncoder().encode(manifestBody).byteLength,
          etag: "manifest-etag",
        },
      ], { result_info: { is_truncated: false } })
    }
    if (url.endsWith(`${artifactKey}.manifest.json`)) {
      return new Response(manifestBody, {
        headers: { "content-length": String(new TextEncoder().encode(manifestBody).byteLength) },
      })
    }
    if (url.endsWith(artifactKey)) {
      return new Response(sql, {
        headers: {
          "content-length": String(manifest.artifact.size),
          "content-type": "application/sql",
          etag: `"${manifest.artifact.etag}"`,
        },
      })
    }
    if (url.endsWith("/d1/database") && method === "POST") return json({ uuid: drillDatabaseId })
    if (url.endsWith(`/d1/database/${drillDatabaseId}/query`)) {
      return json([
        {
          success: true,
          results: ["account", "admin_audit_log", "payment_invoice", "plan_subscription", "usage", "user", "workspace"].map(
            (name) => ({ name }),
          ),
        },
      ])
    }
    if (url.endsWith(`/d1/database/${drillDatabaseId}`) && method === "DELETE") return json({})
    throw new Error(`unexpected request: ${method} ${url}`)
  }
}

function materialized(cleanup: () => void): MaterializedD1Backup {
  return {
    size: manifest.artifact.size,
    md5: "0123456789abcdef0123456789abcdef",
    body: () => new Blob([sql], { type: "application/sql" }),
    cleanup: async () => cleanup(),
  }
}

describe("Cloudflare D1 restore drill", () => {
  test("restores the latest verified dev backup into a disposable D1 and deletes it", async () => {
    const calls: Array<{ url: string; method: string }> = []
    let cleaned = false
    let importedDatabase = ""
    const receipt = await executeD1RestoreDrill(config, {
      fetcher: successfulFetcher(calls),
      now: () => new Date("2026-08-29T01:00:00.000Z"),
      materialize: async (response, selected) => {
        expect(await response.clone().text()).toBe(sql)
        expect(selected.artifact.key).toBe(artifactKey)
        return materialized(() => {
          cleaned = true
        })
      },
      restore: async (input) => {
        importedDatabase = input.databaseId
        expect(input.databaseId).toBe(drillDatabaseId)
        expect(input.databaseId).not.toBe(config.sourceDatabaseId)
        expect(await new Response(input.artifact.body()).text()).toBe(sql)
      },
    })

    expect(importedDatabase).toBe(drillDatabaseId)
    expect(cleaned).toBe(true)
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining(drillDatabaseId) })
    expect(receipt).toMatchObject({
      kind: "mongolgpt-d1-restore-drill",
      stage: "dev",
      backupKey: artifactKey,
      backupCreatedAt: createdAt,
      drillDatabaseName: `mongolgpt-restore-drill-${config.runId}`,
      completedAt: "2026-08-29T01:00:00.000Z",
    })
    expect(receipt.verifiedTables).toEqual([
      "account",
      "admin_audit_log",
      "payment_invoice",
      "plan_subscription",
      "usage",
      "user",
      "workspace",
    ])
  })

  test("deletes the disposable D1 and local backup when import fails", async () => {
    const calls: Array<{ url: string; method: string }> = []
    let cleaned = false
    const error = await expectRejection(
      executeD1RestoreDrill(config, {
        fetcher: successfulFetcher(calls),
        now: () => new Date("2026-08-29T01:00:00.000Z"),
        materialize: async () =>
          materialized(() => {
            cleaned = true
          }),
        restore: async () => {
          throw new Error("import-provider-detail")
        },
      }),
      "import-provider-detail",
    )

    expect(String(error)).not.toContain(config.apiToken)
    expect(cleaned).toBe(true)
    expect(calls.at(-1)?.method).toBe("DELETE")
    expect(String(calls.at(-1)?.url)).toContain(drillDatabaseId)
    expect(calls.some((call) => call.url.endsWith("/query"))).toBe(false)
  })

  test("preserves the restore failure when database and artifact cleanup both fail", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetcher = successfulFetcher(calls)
    const error = await executeD1RestoreDrill(config, {
      fetcher: async (input, init) => {
        const url = inputURL(input)
        if (url.endsWith(`/d1/database/${drillDatabaseId}`) && init?.method === "DELETE") {
          throw new Error("database-cleanup-detail")
        }
        return fetcher(input, init)
      },
      now: () => new Date("2026-08-29T01:00:00.000Z"),
      materialize: async () =>
        materialized(() => {
          throw new Error("artifact-cleanup-detail")
        }),
      restore: async () => {
        throw new Error("import-provider-detail")
      },
    }).catch((value) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error instanceof Error ? error.message : "").toContain("import-provider-detail")
    expect(error instanceof AggregateError ? error.cause : undefined).toMatchObject({ message: "import-provider-detail" })
    expect(error instanceof AggregateError ? error.errors : []).toEqual([
      expect.objectContaining({ message: "import-provider-detail" }),
      expect.objectContaining({ message: "database-cleanup-detail" }),
      expect.objectContaining({ message: "artifact-cleanup-detail" }),
    ])
  })

  test("passes only the required environment to the Wrangler child process", () => {
    const environment = buildD1RestoreDrillChildEnvironment(
      {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/runner",
        MONGOLGPT_RUNTIME_SECRET: "must-not-leak",
        CLOUDFLARE_API_TOKEN: "broad-deploy-token",
        D1_RESTORE_DRILL_API_TOKEN: "parent-restore-token",
      },
      { accountId: config.accountId, apiToken: config.apiToken },
    )

    expect(environment).toEqual({
      CI: "true",
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
      CLOUDFLARE_API_TOKEN: config.apiToken,
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/runner",
    })
    expect(environment).not.toHaveProperty("MONGOLGPT_RUNTIME_SECRET")
    expect(environment).not.toHaveProperty("D1_RESTORE_DRILL_API_TOKEN")
  })

  test("rejects production and stale backups before creating a database", async () => {
    let requested = false
    await expectRejection(
      executeD1RestoreDrill(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Verifies the runtime guard for untyped workflow input.
        { ...config, stage: "production" } as unknown as D1RestoreDrillConfig,
        {
          fetcher: async () => {
            requested = true
            return json({})
          },
          materialize: async () => materialized(() => undefined),
          restore: async () => undefined,
        },
      ),
      "зөвхөн dev",
    )
    expect(requested).toBe(false)

    const calls: Array<{ url: string; method: string }> = []
    await expectRejection(
      executeD1RestoreDrill(config, {
        fetcher: successfulFetcher(calls),
        now: () => new Date("2026-09-01T00:00:00.000Z"),
        materialize: async () => materialized(() => undefined),
        restore: async () => undefined,
      }),
      "36 цагаас хуучин",
    )
    expect(calls.some((call) => call.url.endsWith("/d1/database"))).toBe(false)
  })

  test("quarterly workflow is dev-only, uploads a receipt, and never targets production", async () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const [workflow, script, docs] = await Promise.all([
      Bun.file(path.join(root, ".github/workflows/d1-restore-drill.yml")).text(),
      Bun.file(path.join(root, "script/d1-restore-drill.ts")).text(),
      Bun.file(path.join(root, "packages/web/src/content/docs/backup-restore.mdx")).text(),
    ])

    expect(workflow).toContain('cron: "17 3 1 1,4,7,10 *"')
    expect(workflow).toContain("environment: dev")
    expect(workflow).toContain("bun sst shell --stage=dev")
    expect(workflow).toContain("D1_RESTORE_DRILL_API_TOKEN: ${{ secrets.D1_RESTORE_DRILL_API_TOKEN }}")
    expect(workflow).toContain("env -u CLOUDFLARE_API_TOKEN bun script/d1-restore-drill.ts")
    expect(workflow).toContain("if: always()")
    expect(workflow).toContain("if-no-files-found: error")
    expect(workflow).not.toContain("stage=production")
    expect(script).toContain('database_id: input.databaseId')
    expect(script).not.toContain('database_id: resources.Database.databaseId')
    expect(script).toContain('"--cwd",\n        "packages/console/app",\n        "wrangler"')
    expect(script).not.toContain('"x",\n        "wrangler"')
    expect(script).toContain("buildD1RestoreDrillChildEnvironment(process.env, input)")
    expect(script).not.toContain("env: { ...process.env")
    expect(docs).toContain("D1 restore drill")
  })
})
