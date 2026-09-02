import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { Identifier } from "@mongolgpt/console-core/identifier.js"
import * as schema from "@mongolgpt/console-core/schema-d1/index.js"
import {
  collectAdminProviderHealth,
  summarizeAdminProviderHealth,
  type AdminProviderHealthAggregate,
} from "../src/lib/admin-provider-health.server"
import { formatAdminDate } from "../src/lib/admin-date"

const now = new Date("2026-08-30T17:00:00.000Z")

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../../core/migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

function row(providerID: string, overrides: Partial<AdminProviderHealthAggregate> = {}): AdminProviderHealthAggregate {
  return {
    providerID,
    providerKind: null,
    usageMode: "managed",
    attempts15m: 10,
    successes15m: 10,
    transientFailures15m: 0,
    permanentErrors15m: 0,
    attempts24h: 100,
    successes24h: 99,
    transientFailures24h: 1,
    permanentErrors24h: 0,
    failovers24h: 1,
    fallbackAttempts24h: 0,
    averageLatencyMs24h: 800,
    maxLatencyMs24h: 2_000,
    lastAttemptAt: now.getTime() - 60_000,
    lastSuccessAt: now.getTime() - 60_000,
    lastTransientFailureAt: now.getTime() - 3_600_000,
    ...overrides,
  }
}

describe("admin provider health read model", () => {
  test("renders Ulaanbaatar timestamps with stable Mongolian date words", () => {
    expect(formatAdminDate("2026-08-30T17:20:00.000Z")).toBe("2026 оны 8-р сарын 31, 01:20")
    expect(formatAdminDate("not-a-date")).toBe("Тодорхойгүй огноо")
  })

  test("derives honest states from recent managed-provider evidence", () => {
    const report = summarizeAdminProviderHealth(
      [
        row("healthy-provider"),
        row("degraded-provider", {
          successes15m: 7,
          transientFailures15m: 3,
          transientFailures24h: 12,
          lastTransientFailureAt: now.getTime() - 1_000,
        }),
        row("warning-provider", { successes15m: 9, transientFailures15m: 1 }),
        row("idle-provider", { attempts15m: 0, successes15m: 0, lastAttemptAt: now.getTime() - 16 * 60_000 }),
      ],
      now,
    )

    expect(Object.fromEntries(report.map((provider) => [provider.providerID, provider.state]))).toMatchObject({
      "healthy-provider": "healthy",
      "degraded-provider": "degraded",
      "warning-provider": "warning",
      "idle-provider": "idle",
      "mongolgpt-base-free": "unknown",
      "openrouter-free": "unknown",
      "nvidia-nim-production": "unknown",
    })
    expect(report[0]?.providerID).toBe("degraded-provider")
    expect(report.find((provider) => provider.providerID === "healthy-provider")?.lastAttemptAt).toBe(
      "2026-08-30T16:59:00.000Z",
    )
  })

  test("does not add duplicate base providers when composite routes have evidence", () => {
    const report = summarizeAdminProviderHealth(
      [row("openrouter-free.primary", { providerKind: "openrouter" }), row("nvidia-nim-production.a")],
      now,
    )
    expect(report.map((provider) => provider.providerID)).toEqual([
      "mongolgpt-base-free",
      "nvidia-nim-production.a",
      "openrouter-free.primary",
    ])
  })

  test("aggregates the real D1 timestamp and outcome columns without N+1 provider reads", async () => {
    const sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    const db: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    const insert = sqlite.query(
      "insert into provider_attempt (id, provider, provider_kind, usage_mode, model, outcome, response_status, latency_ms, retry_count, fallback, time_created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (let index = 0; index < 10; index++) {
      const transient = index >= 7
      insert.run(
        Identifier.create("providerAttempt"),
        "openrouter-free",
        "openrouter",
        "managed",
        "free-auto",
        transient ? "transient-error" : "success",
        transient ? 429 : 200,
        100 + index,
        transient ? 1 : 0,
        0,
        now.getTime() - index * 1_000,
      )
    }

    const report = await collectAdminProviderHealth(
      db as unknown as Parameters<typeof collectAdminProviderHealth>[0],
      now,
    )
    const provider = report.find((item) => item.providerID === "openrouter-free")
    expect(provider).toMatchObject({
      state: "degraded",
      attempts15m: 10,
      successes15m: 7,
      transientFailures15m: 3,
      attempts24h: 10,
      failovers24h: 3,
    })
    expect(provider?.averageLatencyMs24h).toBe(105)
    expect(provider?.lastAttemptAt).toBe(now.toISOString())
  })

  test("keeps the query server-only, bounded, read-only, and free of BYOK identity fields", async () => {
    const root = resolve(import.meta.dir, "..")
    const [query, route, view, queueClient] = await Promise.all([
      Bun.file(resolve(root, "src/lib/admin-provider-health.server.ts")).text(),
      Bun.file(resolve(root, "src/routes/index.tsx")).text(),
      Bun.file(resolve(root, "src/component/admin-overview.tsx")).text(),
      Bun.file(resolve(root, "../app/src/routes/gateway/util/quota-service.ts")).text(),
    ])

    expect(query).toContain(".limit(100)")
    expect(query).toContain(".groupBy(ProviderAttemptTable.provider)")
    expect(query).toContain("gte(ProviderAttemptTable.time_created, historyStart)")
    expect(query).not.toContain(".insert(")
    expect(query).not.toContain(".update(")
    expect(query).not.toContain("workspaceID")
    expect(query).not.toContain("apiKey")
    expect(route).toContain('from "~/lib/admin-provider-health.server"')
    expect(view).toContain("Загварын үйлчилгээний төлөв")
    expect(view.replace(/\s+/g, " ")).toContain("BYOK түлхүүр")
    expect(view).toContain("provider.successes24h / provider.attempts24h")
    expect(queueClient).toContain("Resource.UsageQueue.send(event)")
  })
})
