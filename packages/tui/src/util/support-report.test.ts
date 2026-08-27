import { describe, expect, test } from "bun:test"
import { buildSupportReport } from "./support-report"

describe("TUI support report", () => {
  test("copies diagnostics for the first-party support workspace", () => {
    const report = buildSupportReport("Санаандгүй алдаа", "stack line")

    expect(report).toContain("MongolGPT TUI алдааны тайлан")
    expect(report).toContain("Алдаа: Санаандгүй алдаа")
    expect(report).toContain("stack line")
    expect(report).toMatch(/Тусламж: https?:\/\/.+\/support/)
    expect(report).not.toContain("github.com")
  })

  test("fits the customer support message limit", () => {
    const report = buildSupportReport("алдаа", "x".repeat(10_000))

    expect(report.length).toBeLessThanOrEqual(5000)
    expect(report).toContain("... (таслав)")
    expect(report).toMatch(/Тусламж: https?:\/\/.+\/support$/)
  })
})
