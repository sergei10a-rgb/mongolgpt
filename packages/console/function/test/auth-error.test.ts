import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { authStateError, isUnknownAuthStateError, localizeUnknownAuthStateResponse } from "../src/auth-error"

describe("OAuth state error page", () => {
  test("returns a non-cacheable Mongolian recovery page without the upstream error", async () => {
    const response = authStateError("https://dev.mgpt.mn")
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(body).toContain('<html lang="mn">')
    expect(body).toContain("Нэвтрэх хүсэлт хүчингүй боллоо")
    expect(body).toContain('href="https://dev.mgpt.mn/"')
    expect(body).not.toContain("The browser was in an unknown state")
    expect(body).not.toContain("<script")
  })

  test("omits the recovery link when the configured console origin is unsafe", async () => {
    const response = authStateError("https://user:password@example.com/private")
    const body = await response.text()

    expect(body).not.toContain("example.com")
    expect(body).not.toContain("password")
    expect(body).not.toContain("<a ")
  })

  test("recognizes and replaces the upstream plain-text unknown-state response", async () => {
    const message =
      "The browser was in an unknown state. This could be because certain cookies expired or the browser was switched in the middle of an authentication flow."
    const response = await localizeUnknownAuthStateResponse(
      new Response(message, { status: 500, headers: { "content-type": "text/plain; charset=UTF-8" } }),
      "https://dev.mgpt.mn",
    )
    const body = await response.text()

    expect(isUnknownAuthStateError(new Error(message))).toBe(true)
    expect(response.status).toBe(400)
    expect(body).toContain("Нэвтрэх хүсэлт хүчингүй боллоо")
    expect(body).not.toContain(message)
  })

  test("does not replace unrelated upstream failures", async () => {
    const original = Response.json({ error: "database_unavailable" }, { status: 503 })
    expect(await localizeUnknownAuthStateResponse(original, "https://dev.mgpt.mn")).toBe(original)
    expect(isUnknownAuthStateError(new Error("other"))).toBe(false)
  })

  test("keeps the localized recovery response wired into the OpenAuth issuer", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/auth.ts"), "utf8")

    expect(source).toContain("error: async () => authStateError(env.MONGOLGPT_CONSOLE_ORIGIN)")
    expect(source).toContain("localizeUnknownAuthStateResponse(upstream, env.MONGOLGPT_CONSOLE_ORIGIN)")
  })
})
