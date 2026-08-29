import { describe, expect, test } from "bun:test"
import { authStateError } from "../src/auth-error"

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
})
