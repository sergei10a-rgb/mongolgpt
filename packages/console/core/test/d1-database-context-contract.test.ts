import { describe, expect, test } from "bun:test"

describe("D1 database context contract", () => {
  test("nested Database.use reuses the active context without starting a D1 transaction", async () => {
    const source = await Bun.file(new URL("../src/drizzle/index.ts", import.meta.url)).text()
    const useStart = source.indexOf("export async function use")
    const fnStart = source.indexOf("export async function fn", useStart)
    const implementation = source.slice(useStart, fnStart)

    expect(useStart).toBeGreaterThan(-1)
    expect(fnStart).toBeGreaterThan(useStart)
    expect(implementation).toContain("return callback(tx)")
    expect(implementation).not.toContain("tx.transaction(callback)")
  })
})
