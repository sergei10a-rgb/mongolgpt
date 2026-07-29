import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

describe("OAuth account access contract", () => {
  test("checks canonical account state and embeds the revocation version", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../src/auth.ts")).text()

    expect(source).toContain("AccountAccess.verify({ accountID })")
    expect(source).toContain('access.reason === "suspended"')
    expect(source).toContain("authVersion: access.authVersion")
    expect(source).toContain("authVersion: z.number().int().nonnegative().optional()")
    expect(source).not.toContain("authVersion: 0,")
  })
})
