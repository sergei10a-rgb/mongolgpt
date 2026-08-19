import { describe, expect, test } from "bun:test"
import {
  backupObjectKey,
  scheduledBackupTime,
  startD1Export,
  storeCompletedD1Export,
  type BackupBucket,
  type D1BackupConfig,
} from "../src/d1-backup"
import { triggerScheduledD1Backup } from "../src/d1-backup-schedule"

const config: D1BackupConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  apiToken: "secret-token",
  stage: "dev",
}

const maxBackupBytes = 10 * 1024 * 1024 * 1024

async function expectRejection(promise: Promise<unknown>, message: string) {
  let rejected: unknown
  try {
    await promise
  } catch (error) {
    rejected = error
  }
  if (!(rejected instanceof Error)) throw new Error(`Expected rejection containing: ${message}`)
  expect(rejected.message).toContain(message)
}

describe("Cloudflare D1 backup", () => {
  test("starts a polling export against the fixed Cloudflare endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const bookmark = await startD1Export(config, async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return Response.json({ success: true, result: { at_bookmark: "bookmark-1", status: "active" } })
    })

    expect(bookmark).toBe("bookmark-1")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/01234567-89ab-cdef-0123-456789abcdef/export",
    )
    expect(calls[0]?.init).toMatchObject({ method: "POST", body: '{"output_format":"polling"}' })
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret-token")
  })

  test("streams a completed nested export into a deterministic private R2 key", async () => {
    const puts: Array<{ key: string; body: string; options: unknown }> = []
    const bucket: BackupBucket = {
      async put(key, value, options) {
        puts.push({ key, body: await new Response(value).text(), options })
        return { etag: "etag-1", size: 24 }
      },
    }
    let call = 0
    const receipt = await storeCompletedD1Export({
      config,
      bookmark: "bookmark-1",
      scheduledTime: Date.UTC(2026, 7, 2, 0, 20),
      bucket,
      fetcher: async (_input, init) => {
        call++
        if (call === 1) {
          expect(init?.body).toBe('{"current_bookmark":"bookmark-1"}')
          return Response.json({
            success: true,
            result: {
              status: "complete",
              result: {
                filename: "../../mongolgpt backup.sql",
                signed_url: "https://backup.r2.cloudflarestorage.com/export?signature=hidden",
              },
            },
          })
        }
        return new Response("-- valid sqlite export\n", {
          status: 200,
          headers: { "content-length": "24", "content-type": "application/sql" },
        })
      },
    })

    expect(receipt).toEqual({
      key: "d1/dev/2026/08/02/2026-08-02T00-20-00.000Z-mongolgpt-backup.sql",
      etag: "etag-1",
      size: 24,
    })
    expect(puts).toEqual([
      {
        key: receipt.key,
        body: "-- valid sqlite export\n",
        options: {
          httpMetadata: { contentType: "application/sql" },
          customMetadata: {
            createdAt: "2026-08-02T00:20:00.000Z",
            source: "cloudflare-d1-export",
            stage: "dev",
          },
        },
      },
    ])
  })

  test("retries incomplete exports and rejects API, SSRF, and size failures", async () => {
    let putCalls = 0
    const bucket: BackupBucket = {
      put: async () => {
        putCalls++
        return { etag: "unused", size: 1 }
      },
    }
    await expectRejection(
      storeCompletedD1Export({
        config,
        bookmark: "bookmark-1",
        scheduledTime: 1,
        bucket,
        fetcher: async () => Response.json({ success: true, result: { status: "active" } }),
      }),
      "бэлэн болоогүй",
    )
    await expectRejection(
      startD1Export(config, async () =>
        Response.json({ success: false, errors: [{ code: 7500, message: "denied\nrequest" }] }),
      ),
      "7500",
    )
    await expectRejection(
      storeCompletedD1Export({
        config,
        bookmark: "bookmark-1",
        scheduledTime: 1,
        bucket,
        fetcher: async () =>
          Response.json({
            success: true,
            result: {
              status: "complete",
              result: { filename: "backup.sql", signed_url: "https://127.0.0.1/a" },
            },
          }),
      }),
      "зөвшөөрөгдөөгүй",
    )
    await expectRejection(
      storeCompletedD1Export({
        config,
        bookmark: "bookmark-1",
        scheduledTime: 1,
        bucket,
        fetcher: async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.startsWith("https://backup.example")) {
            return new Response("sql", { headers: { "content-length": "10737418241" } })
          }
          return Response.json({
            success: true,
            result: {
              status: "complete",
              result: { filename: "backup.sql", signed_url: "https://backup.example/export" },
            },
          })
        },
      }),
      "хэмжээ буруу байна",
    )
    expect(putCalls).toBe(0)
  })

  test("fails closed when a chunked response exceeds the byte cap", async () => {
    let putCalls = 0
    const bucket: BackupBucket = {
      async put(_key, value) {
        putCalls++
        const reader = value.getReader()
        while (!(await reader.read()).done) {}
        return { etag: "unused", size: 1 }
      },
    }
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- avoids allocating a 10 GiB test chunk
        controller.enqueue({ byteLength: maxBackupBytes - 1 } as Uint8Array)
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic overflow chunk
        controller.enqueue({ byteLength: 2 } as Uint8Array)
        controller.close()
      },
    })

    await expectRejection(
      storeCompletedD1Export({
        config,
        bookmark: "bookmark-1",
        scheduledTime: 1,
        bucket,
        fetcher: async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.startsWith("https://backup.example")) {
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fetch response test double
            return {
              ok: true,
              status: 200,
              url,
              headers: new Headers({ "content-length": "1" }),
              body: chunkedBody,
            } as Response
          }
          return Response.json({
            success: true,
            result: {
              status: "complete",
              result: { filename: "backup.sql", signed_url: "https://backup.example/export" },
            },
          })
        },
      }),
      "хязгаараас хэтэрлээ",
    )
    expect(putCalls).toBe(1)
  })

  test("accepts an exact-cap stream and rejects an oversized R2 receipt", async () => {
    const exactBody = new ReadableStream<Uint8Array>({
      start(controller) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- avoids allocating a 10 GiB test chunk
        controller.enqueue({ byteLength: maxBackupBytes } as Uint8Array)
        controller.close()
      },
    })
    const exactBucket: BackupBucket = {
      async put(_key, value) {
        const reader = value.getReader()
        while (!(await reader.read()).done) {}
        return { etag: "etag-exact", size: maxBackupBytes }
      },
    }
    const fetcher = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith("https://backup.example")) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fetch response test double
        return { ok: true, status: 200, url, headers: new Headers(), body: exactBody } as Response
      }
      return Response.json({
        success: true,
        result: { status: "complete", result: { filename: "backup.sql", signed_url: "https://backup.example/export" } },
      })
    }
    expect(
      await storeCompletedD1Export({
        config,
        bookmark: "bookmark-1",
        scheduledTime: 1,
        bucket: exactBucket,
        fetcher,
      }),
    ).toMatchObject({ etag: "etag-exact", size: maxBackupBytes })

    const oversizedReceiptBucket: BackupBucket = {
      put: async () => ({ etag: "etag-too-large", size: maxBackupBytes + 1 }),
    }
    await expectRejection(
      storeCompletedD1Export({
        config,
        bookmark: "bookmark-1",
        scheduledTime: 1,
        bucket: oversizedReceiptBucket,
        fetcher: async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.startsWith("https://backup.example"))
            return new Response("sql", { headers: { "content-length": "3" } })
          return Response.json({
            success: true,
            result: {
              status: "complete",
              result: { filename: "backup.sql", signed_url: "https://backup.example/export" },
            },
          })
        },
      }),
      "баталгаажуулсангүй",
    )
  })

  test("normalizes object keys and validates event timestamps", () => {
    expect(backupObjectKey("Production", 0, "dump")).toBe("d1/production/1970/01/01/1970-01-01T00-00-00.000Z-dump.sql")
    expect(scheduledBackupTime(undefined, new Date(1234))).toBe(1234)
    expect(() => scheduledBackupTime(Number.NaN, new Date(1234))).toThrow("товлосон хугацаа")
    expect(() => backupObjectKey("../dev", 0, "dump.sql")).toThrow("stage")
  })

  test("triggers a bounded-retention workflow instance from cron", async () => {
    const calls: unknown[] = []
    const result = await triggerScheduledD1Backup(1234, {
      async create(input) {
        calls.push(input)
        return { id: "workflow-1" }
      },
    })
    expect(result).toEqual({ instanceId: "workflow-1", scheduledTime: 1234 })
    expect(calls).toEqual([
      {
        params: { scheduledTime: 1234 },
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      },
    ])
  })
})
