import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  d1RestoreConfirmation,
  executeD1Restore,
  normalizeD1RestoreTarget,
  planD1Restore,
  type D1RestoreConfig,
} from "../src/d1-restore"

const config: D1RestoreConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  apiToken: "secret-token",
  stage: "dev",
}
const current = "00000001-00000002-00000003-00000004"
const target = "00000005-00000006-00000007-00000008"
const restored = "00000009-00000010-00000011-00000012"

function json(result: unknown, status = 200) {
  return Response.json({ success: status < 400, result, errors: [] }, { status })
}

describe("D1 сэргээх аюулгүй урсгал", () => {
  test("хугацааг UTC ISO 8601 утга болгон хэвийн болгоно", () => {
    expect(normalizeD1RestoreTarget({ kind: "timestamp", value: "2026-08-27T12:30:00+08:00" })).toEqual({
      kind: "timestamp",
      value: "2026-08-27T04:30:00.000Z",
    })
    expect(d1RestoreConfirmation("production", { kind: "bookmark", value: target })).toBe(
      `RESTORE D1 production ${target}`,
    )
  })

  test("одоогийн болон хугацаанд харгалзах зорилтот bookmark-ийг уншиж төлөвлөгөө гаргана", async () => {
    const urls: string[] = []
    const fetcher = async (request: RequestInfo | URL) => {
      const url = String(request)
      urls.push(url)
      return json({ bookmark: url.includes("timestamp=") ? target : current })
    }

    const plan = await planD1Restore(config, { kind: "timestamp", value: "2026-08-27T04:30:00Z" }, fetcher)
    expect(plan).toMatchObject({ currentBookmark: current, targetBookmark: target })
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain("timestamp=2026-08-27T04%3A30%3A00.000Z")
  })

  test("яг тохирох баталгаажуулалтгүй үед API руу хүсэлт илгээхгүй", async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return json({ bookmark: current })
    }

    await expect(
      executeD1Restore({ config, target: { kind: "bookmark", value: target }, confirmation: "RESTORE", fetcher }),
    ).rejects.toThrow("баталгаажуулалт таарахгүй")
    expect(calls).toBe(0)
  })

  test("POST хийхээс өмнө төлөвлөгөөг хадгалж, буцаалтын bookmark бүхий receipt үүсгэнэ", async () => {
    const calls: { url: string; method: string }[] = []
    let prepared = false
    const fetcher = async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      const method = init?.method ?? "GET"
      calls.push({ url, method })
      if (method === "GET") return json({ bookmark: current })
      expect(prepared).toBe(true)
      return json({ bookmark: restored, previous_bookmark: current, message: "Database restored successfully" })
    }

    const receipt = await executeD1Restore({
      config,
      target: { kind: "bookmark", value: target },
      confirmation: `RESTORE D1 dev ${target}`,
      fetcher,
      now: () => new Date("2026-08-27T05:00:00Z"),
      prepared: async (plan) => {
        expect(plan.currentBookmark).toBe(current)
        prepared = true
      },
    })

    expect(calls).toEqual([
      expect.objectContaining({ method: "GET" }),
      expect.objectContaining({ method: "POST", url: expect.stringContaining(`bookmark=${target}`) }),
    ])
    expect(receipt).toMatchObject({
      previousBookmark: current,
      restoredBookmark: restored,
      previousBookmarkMatchesPlan: true,
      restoredAt: "2026-08-27T05:00:00.000Z",
    })
  })

  test("API алдаанд token-ийг задруулахгүй", async () => {
    const fetcher = async () =>
      Response.json({ success: false, errors: [{ code: 7400, message: "Permission denied" }] }, { status: 403 })

    const error = await planD1Restore(config, { kind: "bookmark", value: target }, fetcher).catch((value) => value)
    expect(String(error)).toContain("7400: Permission denied")
    expect(String(error)).not.toContain(config.apiToken)
  })

  test("GitHub сэргээх урсгалыг зөвхөн гараар ажиллуулж, оролтыг shell мөрөнд шууд оруулахгүй", async () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const [workflow, script, docs] = await Promise.all([
      Bun.file(path.join(root, ".github/workflows/d1-restore.yml")).text(),
      Bun.file(path.join(root, "script/d1-restore.ts")).text(),
      Bun.file(path.join(root, "packages/web/src/content/docs/backup-restore.mdx")).text(),
    ])

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toMatch(/\n\s+(push|schedule):/)
    expect(workflow).toContain("environment: ${{ inputs.stage }}")
    expect(workflow).toContain("MONGOLGPT_D1_RESTORE_TARGET: ${{ inputs.target }}")
    expect(workflow).toContain('"$target_flag" "$MONGOLGPT_D1_RESTORE_TARGET"')
    expect(workflow).not.toContain('--${{ inputs.target_kind }} "${{ inputs.target }}"')
    expect(workflow).toContain("Upload restore receipt")
    expect(script).toContain('if (!receiptPath) fail("Сэргээх үед --receipt <path> заавал өгнө.")')
    expect(docs).toContain("previousBookmarkMatchesPlan=false")
  })
})
