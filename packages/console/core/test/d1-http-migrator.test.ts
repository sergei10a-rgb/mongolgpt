import { describe, expect, test } from "bun:test"
import { migrateD1 } from "../src/d1-http-migrator"

type Query = { sql: string; params: string[] }
type RequestBody = Query | { batch: Query[] }

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const DATABASE_ID = "01234567-89ab-4def-8123-456789abcdef"

describe("D1 HTTP migrator", () => {
  test("keeps every migration statement separate inside transactional batches", async () => {
    const bodies: RequestBody[] = []
    const applied: string[] = []
    const result = await migrateD1({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: "test-token",
      fetch: async (_input, init) => {
        const body = requireRequestBody(init?.body)
        bodies.push(body)
        const results = "batch" in body ? body.batch.map(() => successfulResult()) : [successfulResult([])]
        return Response.json({ success: true, errors: [], messages: [], result: results })
      },
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      onApplied: (name) => applied.push(name),
    })

    expect(result.applied).toBe(result.total)
    expect(result.total).toBeGreaterThan(0)
    expect(applied).toHaveLength(result.total)
    const batches = bodies.flatMap((body) => ("batch" in body ? [body.batch] : []))
    expect(batches).toHaveLength(result.total)
    expect(
      batches.every((batch) => batch.at(-1)?.sql.startsWith("INSERT INTO __drizzle_migrations")),
    ).toBeTrue()
    const triggers = batches.flat().filter((query) => query.sql.includes("CREATE TRIGGER"))
    expect(triggers.length).toBeGreaterThan(0)
    expect(triggers.every((query) => query.sql.includes("BEGIN") && query.sql.includes("END;"))).toBeTrue()
    expect(batches.flat().some((query) => query.sql.includes("--> statement-breakpoint"))).toBeFalse()
    expect(JSON.stringify(bodies)).not.toContain("test-token")
  })

  test("fails closed when application tables exist without migration history", async () => {
    let call = 0
    const promise = migrateD1({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: "test-token",
      fetch: async () => {
        call++
        const rows = call === 3 ? [{ name: "account" }] : []
        return Response.json({ success: true, result: [successfulResult(rows)] })
      },
    })

    expect(await rejectionMessage(promise)).toContain("migration бүртгэл алга")
    expect(call).toBe(3)
  })

  test("rejects changed migration files before sending a batch", async () => {
    let call = 0
    const promise = migrateD1({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      apiToken: "test-token",
      fetch: async () => {
        call++
        const rows =
          call === 2
            ? [
                {
                  id: 1,
                  hash: "0".repeat(64),
                  created_at: 1784242728000,
                  name: "20260716215848_tiny_dagger",
                },
              ]
            : []
        return Response.json({ success: true, result: [successfulResult(rows)] })
      },
    })

    expect(await rejectionMessage(promise)).toContain("migration өөрчлөгдсөн")
    expect(call).toBe(2)
  })
})

function successfulResult(results: Record<string, unknown>[] = []) {
  return { success: true, results, meta: { changes: 0 } }
}

async function rejectionMessage(promise: Promise<unknown>) {
  const result = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(result instanceof Error)) throw new Error("D1 migration алдаа буцаасангүй")
  return result.message
}

function requireRequestBody(body: BodyInit | null | undefined): RequestBody {
  if (typeof body !== "string") throw new Error("D1 request body string биш байна")
  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== "object") throw new Error("D1 request body object биш байна")
  if ("batch" in parsed) {
    if (!Array.isArray(parsed.batch)) throw new Error("D1 batch буруу байна")
    return { batch: parsed.batch.map(requireQuery) }
  }
  return requireQuery(parsed)
}

function requireQuery(value: unknown): Query {
  if (!value || typeof value !== "object" || !("sql" in value) || !("params" in value)) {
    throw new Error("D1 query буруу байна")
  }
  if (typeof value.sql !== "string" || !Array.isArray(value.params) || !value.params.every((item) => typeof item === "string")) {
    throw new Error("D1 query талбар буруу байна")
  }
  return { sql: value.sql, params: value.params }
}
