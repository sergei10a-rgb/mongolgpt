import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { resolve } from "node:path"
import { Effect } from "effect"

let sqlite: SQLite

const database = {
  prepare(query: string) {
    let parameters: unknown[] = []
    const statement = {
      bind(...values: unknown[]) {
        parameters = values
        return statement
      },
      async all() {
        return { results: sqlite.query(query).all(...parameters) }
      },
    }
    return statement
  },
}

mock.module("@mongolgpt/console-resource", () => ({ Resource: { Database: database } }))

const { getStatsHomeData, getStatsLabData, getStatsModelData } = await import("../src/domain/home")

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../../../console/core/migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

describe("Cloudflare D1 статистик", () => {
  beforeEach(async () => {
    sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
    sqlite
      .query(
        `insert into usage (
          id, workspace_id, time_created, time_updated, model, provider,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
          cost, input_cost, output_cost, country, continent, session_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "usage_1",
        "workspace_1",
        Date.UTC(2026, 6, 17, 1),
        Date.UTC(2026, 6, 17, 2),
        "free-auto",
        "nvidia",
        10,
        20,
        5,
        2,
        100,
        40,
        60,
        "MN",
        "AS",
        "session_1",
      )
  })

  afterEach(() => sqlite.close())

  test("түүхий хэрэглээг нүүр, provider, model статистикт зөв нэгтгэнэ", async () => {
    const home = await Effect.runPromise(getStatsHomeData())
    const lab = await Effect.runPromise(getStatsLabData("nvidia"))
    const model = await Effect.runPromise(getStatsModelData("free-auto", "nvidia"))

    expect(home.leaderboard["All Users"]["1W"][0]).toMatchObject({
      model: "free-auto",
      provider: "nvidia",
      tokens: 37,
    })
    expect(home.market.ALL[0]).toMatchObject({ total: 37 })
    expect(home.country.ALL[0]).toMatchObject({ country: "MN", continent: "AS", tokens: 37 })
    expect(lab?.totals).toMatchObject({ sessions: 1, tokens: 37, models: 1 })
    expect(model?.totals).toMatchObject({ sessions: 1, uniqueUsers: 1, tokens: 37 })
  })
})
