import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import {
  accountDeviceFallbackAllowed,
  accountOnboardingRequired,
  defaultConsoleUrl,
  formatAccountLabel,
  formatOrgLine,
  formatPostLoginGuidance,
  normalizeAccountLoginUrl,
} from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("uses the local console as the default login URL", () => {
    expect(defaultConsoleUrl).toBe("http://localhost:3000")
  })

  test("disables device-code downgrade for official hosted account services", () => {
    expect(accountDeviceFallbackAllowed("https://mgpt.mn")).toBe(false)
    expect(accountDeviceFallbackAllowed("https://dev.mgpt.mn/console")).toBe(false)
    expect(accountDeviceFallbackAllowed("https://mgpt.mn./custom-prefix")).toBe(false)
  })

  test("keeps device-code compatibility for custom account services", () => {
    expect(accountDeviceFallbackAllowed("https://accounts.example.com")).toBe(true)
  })

  test("rejects insecure official account service URLs", () => {
    expect(() => normalizeAccountLoginUrl("http://mgpt.mn")).toThrow("HTTPS")
    expect(normalizeAccountLoginUrl("http://accounts.example.com/path/")).toBe("http://accounts.example.com/path")
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (идэвхтэй)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })

  test("describes default and optional model guidance after login in Mongolian", () => {
    expect(formatPostLoginGuidance()).toEqual([
      "Бүртгэлээр нэвтэрсний дараа MongolGPT Free Auto анхдагчаар идэвхжинэ.",
      "Орон нутгийн болон OpenAI-тэй нийцтэй загваруудыг хүсвэл дараа нь нэмэлтээр холбоно.",
      "NVIDIA NIM-ийг өөрийн API түлхүүрээр хувийн хөгжүүлэлт, туршилт, үнэлгээнд холбоно. Үйлдвэрлэлийн хэрэглээнд зохих NVIDIA лиценз эсвэл захиалга шаардлагатай.",
    ])
  })

  test("does not promise perpetual free access or production rights in post-login guidance", () => {
    const combined = formatPostLoginGuidance().join(" ").toLowerCase()

    expect(combined).not.toContain("үүрд")
    expect(combined).not.toContain("байнгын")
    expect(combined).not.toContain("production")
    expect(combined).not.toContain("продакшн")
  })

  test("requires account onboarding until an active workspace exists", () => {
    expect(accountOnboardingRequired(false)).toBe(true)
    expect(accountOnboardingRequired(true)).toBe(false)
  })
})
