import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  buildD1R2RestoreChildEnvironment,
  d1R2RecoveryDatabaseName,
  d1R2RestoreConfirmation,
  executeD1R2Restore,
  planD1R2Restore,
  type D1R2RestoreConfig,
  type MaterializedD1R2Backup,
} from "../src/d1-r2-restore"

const sql = "CREATE TABLE account (id TEXT);"
const md5 = createHash("md5").update(sql).digest("hex")
const createdAt = "2026-08-29T00:20:00.000Z"
const artifactKey = "d1/dev/2026/08/29/2026-08-29T00-20-00.000Z-database.sql"
const manifestKey = `${artifactKey}.manifest.json`
const sourceDatabaseId = "01234567-89ab-cdef-0123-456789abcdef"
const recoveryDatabaseId = "11111111-2222-3333-4444-555555555555"
const operationId = "33347170215-1"
const config: D1R2RestoreConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  sourceDatabaseId,
  backupBucket: "mongolgpt-d1-backups",
  apiToken: "restore-secret-token",
  stage: "dev",
  operationId,
}

function manifest(size = new TextEncoder().encode(sql).byteLength) {
  return {
    version: 1,
    kind: "mongolgpt-d1-backup",
    source: "cloudflare-d1-export",
    stage: "dev",
    databaseId: sourceDatabaseId,
    bookmark: "00000001-00000002-00000003-00000004",
    createdAt,
    artifact: { key: artifactKey, size, etag: md5, contentType: "application/sql" },
  } as const
}

function objectList(
  input: {
    artifactOverrides?: Record<string, unknown>
    manifestOverrides?: Record<string, unknown>
    size?: number
  } = {},
) {
  const value = manifest(input.size)
  const manifestBody = JSON.stringify(value)
  return {
    success: true,
    result: [
      {
        key: artifactKey,
        size: value.artifact.size,
        etag: md5,
        http_metadata: { contentType: "application/sql" },
        custom_metadata: {
          createdAt,
          source: "cloudflare-d1-export",
          stage: "dev",
          databaseId: sourceDatabaseId,
          manifestVersion: "1",
        },
        ...input.artifactOverrides,
      },
      {
        key: manifestKey,
        size: new TextEncoder().encode(manifestBody).byteLength,
        etag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        http_metadata: { contentType: "application/json" },
        custom_metadata: {
          createdAt,
          source: "mongolgpt-d1-backup-manifest",
          stage: "dev",
          databaseId: sourceDatabaseId,
          version: "1",
        },
        ...input.manifestOverrides,
      },
    ],
    result_info: { is_truncated: false },
  }
}

function json(result: unknown, status = 200) {
  return Response.json(record(result) && "success" in result ? result : { success: status < 400, result, errors: [] }, {
    status,
  })
}

function responseWithMetadata(body: BodyInit, object: { size: number; etag: string; contentType: string }) {
  return new Response(body, {
    headers: {
      "content-length": String(object.size),
      "content-type": object.contentType,
      etag: `"${object.etag}"`,
    },
  })
}

function successfulFetcher(
  calls: Array<{ url: string; method: string }>,
  overrides: { list?: ReturnType<typeof objectList>; manifest?: ReturnType<typeof manifest> } = {},
) {
  const selectedManifest = overrides.manifest ?? manifest()
  const manifestBody = JSON.stringify(selectedManifest)
  const list = overrides.list ?? objectList({ size: selectedManifest.artifact.size })
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method })
    if (url.includes("/r2/buckets/") && url.includes("/objects?")) return json(list)
    if (url.endsWith(manifestKey)) {
      const listed = list.result.find((item) => item.key === manifestKey)!
      return responseWithMetadata(manifestBody, {
        size: listed.size as number,
        etag: listed.etag as string,
        contentType: "application/json",
      })
    }
    if (url.endsWith(artifactKey)) {
      return responseWithMetadata(sql, {
        size: selectedManifest.artifact.size,
        etag: selectedManifest.artifact.etag,
        contentType: "application/sql",
      })
    }
    if (url.endsWith("/d1/database") && method === "POST") return json({ uuid: recoveryDatabaseId })
    if (url.endsWith(`/d1/database/${recoveryDatabaseId}/query`) && method === "POST") {
      const payload = JSON.parse(String(init?.body)) as { sql: string }
      if (payload.sql === "PRAGMA integrity_check")
        return json([{ success: true, results: [{ integrity_check: "ok" }] }])
      return json([
        {
          success: true,
          results: [
            "account",
            "admin_audit_log",
            "payment_invoice",
            "plan_subscription",
            "usage",
            "user",
            "workspace",
          ].map((name) => ({ name })),
        },
      ])
    }
    if (url.endsWith(`/d1/database/${recoveryDatabaseId}`) && method === "DELETE") return json({})
    throw new Error(`unexpected request: ${method} ${url}`)
  }
}

function materialized(cleanup: () => void): MaterializedD1R2Backup {
  return {
    size: new TextEncoder().encode(sql).byteLength,
    md5,
    cleanup: async () => cleanup(),
  }
}

describe("Cloudflare D1 R2 restore", () => {
  test("plans an exact verified backup into a deterministic recovery database", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const plan = await planD1R2Restore(
      config,
      artifactKey,
      successfulFetcher(calls),
      new Date("2026-08-29T01:00:00.000Z"),
    )

    expect(plan).toEqual({
      version: 1,
      kind: "mongolgpt-d1-r2-restore-plan",
      stage: "dev",
      backupKeySha256: createHash("sha256").update(artifactKey).digest("hex"),
      backupCreatedAt: createdAt,
      backupSize: new TextEncoder().encode(sql).byteLength,
      recoveryDatabaseName: d1R2RecoveryDatabaseName("dev", operationId),
      confirmation: d1R2RestoreConfirmation("dev", artifactKey),
    })
    expect(calls.some((call) => call.url.endsWith(artifactKey))).toBe(false)
  })

  test("restores into a new D1, verifies integrity, and preserves the recovery database", async () => {
    const calls: Array<{ url: string; method: string }> = []
    let cleaned = false
    let prepared = false
    const receipt = await executeD1R2Restore({
      config,
      backupKey: artifactKey,
      confirmation: d1R2RestoreConfirmation("dev", artifactKey),
      options: {
        fetcher: successfulFetcher(calls),
        now: () => new Date("2026-08-29T01:00:00.000Z"),
        prepared: async (plan) => {
          prepared = true
          expect(plan.recoveryDatabaseName).toBe(`mongolgpt-r2-recovery-dev-${operationId}`)
        },
        materialize: async (response) => {
          expect(await response.text()).toBe(sql)
          return materialized(() => {
            cleaned = true
          })
        },
        restore: async (input) => {
          expect(input.databaseId).toBe(recoveryDatabaseId)
          expect(input.databaseId).not.toBe(sourceDatabaseId)
        },
      },
    })

    expect(prepared).toBe(true)
    expect(cleaned).toBe(true)
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
    expect(receipt).toMatchObject({
      kind: "mongolgpt-d1-r2-restore",
      stage: "dev",
      recoveryDatabaseName: `mongolgpt-r2-recovery-dev-${operationId}`,
      integrityCheck: "ok",
      completedAt: "2026-08-29T01:00:00.000Z",
    })
    expect(receipt.verifiedTables).toHaveLength(7)
  })

  test("rejects a wrong confirmation before any Cloudflare request", async () => {
    let calls = 0
    await expect(
      executeD1R2Restore({
        config,
        backupKey: artifactKey,
        confirmation: "RESTORE",
        options: {
          fetcher: async () => {
            calls += 1
            return json({})
          },
          materialize: async () => materialized(() => undefined),
          restore: async () => undefined,
        },
      }),
    ).rejects.toThrow("баталгаажуулалт таарахгүй")
    expect(calls).toBe(0)
  })

  test("deletes a newly-created recovery D1 when import fails", async () => {
    const calls: Array<{ url: string; method: string }> = []
    let cleaned = false
    const error = await executeD1R2Restore({
      config,
      backupKey: artifactKey,
      confirmation: d1R2RestoreConfirmation("dev", artifactKey),
      options: {
        fetcher: successfulFetcher(calls),
        materialize: async () =>
          materialized(() => {
            cleaned = true
          }),
        restore: async () => {
          throw new Error("import-provider-detail")
        },
      },
    }).catch((value) => value)

    expect(String(error)).toContain("import-provider-detail")
    expect(String(error)).not.toContain(config.apiToken)
    expect(cleaned).toBe(true)
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining(recoveryDatabaseId) })
  })

  test("never deletes or imports into the source D1 when create returns its ID", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const baseFetcher = successfulFetcher(calls)
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      if (url.endsWith("/d1/database") && method === "POST") {
        calls.push({ url, method })
        return json({ uuid: sourceDatabaseId })
      }
      return baseFetcher(input, init)
    }
    let restored = false
    let cleaned = false

    await expect(
      executeD1R2Restore({
        config,
        backupKey: artifactKey,
        confirmation: d1R2RestoreConfirmation("dev", artifactKey),
        options: {
          fetcher,
          materialize: async () =>
            materialized(() => {
              cleaned = true
            }),
          restore: async () => {
            restored = true
          },
        },
      }),
    ).rejects.toThrow("эх өгөгдлийн сантай ижил")

    expect(restored).toBe(false)
    expect(cleaned).toBe(true)
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
  })

  test("preserves the import failure when recovery D1 cleanup also fails", async () => {
    const calls: Array<{ url: string; method: string }> = []
    const baseFetcher = successfulFetcher(calls)
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        calls.push({ url: String(input), method: "DELETE" })
        throw new Error("cleanup-provider-detail")
      }
      return baseFetcher(input, init)
    }

    const error = await executeD1R2Restore({
      config,
      backupKey: artifactKey,
      confirmation: d1R2RestoreConfirmation("dev", artifactKey),
      options: {
        fetcher,
        materialize: async () => materialized(() => undefined),
        restore: async () => {
          throw new Error("import-provider-detail")
        },
      },
    }).catch((value) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map(String).join(" ")).toContain("import-provider-detail")
    expect((error as AggregateError).errors.map(String).join(" ")).toContain("cleanup-provider-detail")
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining(recoveryDatabaseId) })
  })

  test("fails closed on mismatched metadata and backups larger than the supported import limit", async () => {
    const metadataCalls: Array<{ url: string; method: string }> = []
    const badList = objectList({
      artifactOverrides: {
        custom_metadata: {
          createdAt,
          source: "cloudflare-d1-export",
          stage: "production",
          databaseId: sourceDatabaseId,
          manifestVersion: "1",
        },
      },
    })
    await expect(
      planD1R2Restore(config, artifactKey, successfulFetcher(metadataCalls, { list: badList })),
    ).rejects.toThrow("custom metadata")
    expect(metadataCalls.some((call) => call.url.endsWith("/d1/database"))).toBe(false)

    const tooLarge = 5 * 1024 * 1024 * 1024 + 1
    const largeManifest = manifest(tooLarge)
    const largeList = objectList({ size: tooLarge })
    await expect(
      planD1R2Restore(config, artifactKey, successfulFetcher([], { manifest: largeManifest, list: largeList })),
    ).rejects.toThrow("5 GiB")
  })

  test("passes only the dedicated token and required system variables to Wrangler", () => {
    const environment = buildD1R2RestoreChildEnvironment(
      {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/runner",
        MONGOLGPT_RUNTIME_SECRET: "must-not-leak",
        CLOUDFLARE_API_TOKEN: "broad-deploy-token",
        D1_R2_RESTORE_API_TOKEN: "parent-restore-token",
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
  })

  test("manual workflow is approval-gated, receipt-backed, and keeps raw inputs out of shell flags", async () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const [workflow, script, docs] = await Promise.all([
      Bun.file(path.join(root, ".github/workflows/d1-r2-restore.yml")).text(),
      Bun.file(path.join(root, "script/d1-r2-restore.ts")).text(),
      Bun.file(path.join(root, "packages/web/src/content/docs/backup-restore.mdx")).text(),
    ])

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toMatch(/\n\s+(push|schedule):/)
    expect(workflow).toContain("environment: ${{ inputs.stage }}")
    expect(workflow).toContain("D1_R2_RESTORE_API_TOKEN: ${{ secrets.D1_R2_RESTORE_API_TOKEN }}")
    expect(workflow).toContain("env -u CLOUDFLARE_API_TOKEN bun script/d1-r2-restore.ts")
    expect(workflow).toContain('"$MONGOLGPT_D1_R2_RESTORE_BACKUP_KEY"')
    expect(workflow).not.toContain('--backup-key "${{ inputs.backup_key }}"')
    expect(workflow).toContain("if: always()")
    expect(workflow).toContain("if-no-files-found: error")
    expect(script).toContain("buildD1R2RestoreChildEnvironment(process.env, input)")
    expect(script).not.toContain("env: { ...process.env")
    expect(script).toContain('backupKeySha256: createHash("sha256").update(backupKey).digest("hex")')
    expect(script).toContain('writeReceipt({ ...receiptContext, status: "passed", receipt })')
    expect(script).toMatch(/catch \(error\)[\s\S]*?writeReceipt\(\{\s*\.\.\.receiptContext,\s*status: "failed"/)
    expect(docs).toContain("D1 R2 restore")
    expect(docs).toContain("single-PUT")
  })
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
