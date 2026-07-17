import { describe, expect, test } from "bun:test"
import { createRemoteD1 } from "../remote-d1"

describe("remote D1 adapter", () => {
  test("binds parameters and maps object and raw results", async () => {
    const requests: { url: string; body: { sql: string; params: unknown[] } }[] = []
    const database = createRemoteD1({
      accountId: "account",
      databaseId: "database",
      apiToken: "secret-token",
      fetch: async (input, init) => {
        const url = String(input)
        requests.push({ url, body: JSON.parse(String(init?.body)) })
        const raw = url.endsWith("/raw")
        return Response.json({
          success: true,
          result: [
            raw
              ? { success: true, results: { columns: ["id"], rows: [["row-1"]] }, meta: { changes: 0 } }
              : { success: true, results: [{ id: "row-1" }], meta: { changes: 0 } },
          ],
        })
      },
    })

    const statement = database.prepare("select id from account where id = ?").bind("row-1")
    expect((await statement.all()).results).toEqual([{ id: "row-1" }])
    expect(await statement.raw()).toEqual([["row-1"]])
    expect(requests.map((item) => item.body.params)).toEqual([["row-1"], ["row-1"]])
  })

  test("keeps transaction control local and does not leak the API token in errors", async () => {
    let calls = 0
    const database = createRemoteD1({
      accountId: "account",
      databaseId: "database",
      apiToken: "secret-token",
      fetch: async () => {
        calls++
        return Response.json({ success: false, errors: [{ message: "bad query" }] }, { status: 400 })
      },
    })

    await database.prepare("begin").run()
    await database.prepare("commit").run()
    expect(calls).toBe(0)

    await expect(database.prepare("select broken").run()).rejects.toThrow("bad query")
    await expect(database.prepare("select broken").run()).rejects.not.toThrow("secret-token")
  })

  test("queues overlapping local transaction controls", async () => {
    const database = createRemoteD1({
      accountId: "account",
      databaseId: "database",
      apiToken: "secret-token",
      fetch: async () => Response.json({ success: true, result: [] }),
    })

    await database.prepare("begin").run()
    let secondStarted = false
    const second = database
      .prepare("begin")
      .run()
      .then(() => {
        secondStarted = true
      })

    await Promise.resolve()
    expect(secondStarted).toBe(false)
    await database.prepare("commit").run()
    await second
    expect(secondStarted).toBe(true)
    await database.prepare("commit").run()
  })
})
