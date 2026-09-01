import { describe, expect, test } from "bun:test"
import { adminServiceRequest, resolveAdminServiceURL } from "../src/lib/admin-service"

describe("admin service URL", () => {
  test("resolves a bounded path against an HTTPS service origin", () => {
    expect(resolveAdminServiceURL({ url: "https://quota.example.com" }, "/v1/ledger").href).toBe(
      "https://quota.example.com/v1/ledger",
    )
  })

  test.each([
    ["http://quota.example.com", "/health"],
    ["https://user:password@quota.example.com", "/health"],
    ["https://quota.example.com:8443", "/health"],
    ["https://quota.example.com/base", "/health"],
    ["https://quota.example.com?next=evil", "/health"],
    ["https://quota.example.com", "//evil.example.com"],
    ["https://quota.example.com", "/\\evil.example.com"],
    ["https://quota.example.com", "health"],
    ["https://quota.example.com", "/health\r\nX-Test: yes"],
  ])("rejects unsafe service URL input: %s %s", (url, path) => {
    expect(() => resolveAdminServiceURL({ url }, path)).toThrow()
  })

  test("service fetch refuses redirects even when a caller requests follow mode", () => {
    const request = adminServiceRequest({ url: "https://quota.example.com" }, "/health", { redirect: "follow" })
    expect(request.url.href).toBe("https://quota.example.com/health")
    expect(request.init.redirect).toBe("error")
  })
})
