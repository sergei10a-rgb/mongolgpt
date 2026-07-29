import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

describe("admin security contract", () => {
  test("registers fail-closed middleware", async () => {
    const vite = await source("vite.config.ts")
    const middleware = await source("src/middleware.ts")

    expect(vite).toContain('middleware: "./src/middleware.ts"')
    expect(middleware).toContain('headers.get("cf-access-jwt-assertion")')
    expect(middleware).toContain("verifyCloudflareAccessAssertion")
    expect(middleware).toContain("authorizePlatformAdmin")
    expect(middleware).not.toMatch(/AUTH_BYPASS|ADMIN_BYPASS|NODE_ENV\s*===\s*["']development/)
  })

  test("sets no-store and browser hardening headers", async () => {
    const middleware = await source("src/middleware.ts")

    expect(middleware).toContain('"Cache-Control", "no-store, max-age=0"')
    expect(middleware).toContain('"Content-Security-Policy"')
    expect(middleware).toContain('"X-Content-Type-Options", "nosniff"')
    expect(middleware).toContain('"X-Frame-Options", "DENY"')
  })

  test("contains no raw support lookup endpoint", async () => {
    expect(await Bun.file(resolve(import.meta.dir, "../src/routes/lookup.tsx")).exists()).toBe(false)
    expect(await Bun.file(resolve(import.meta.dir, "../src/lib/lookup.ts")).exists()).toBe(false)
  })
})
