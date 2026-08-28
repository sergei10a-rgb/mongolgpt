import { describe, expect, test } from "bun:test"
import { previewAuthRedirect, previewWwwRedirect } from "./preview-alias"

describe("preview auth alias", () => {
  test("redirects root preview auth requests to the canonical dev console", () => {
    expect(
      previewAuthRedirect(
        "https://mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp",
        "https://dev.mgpt.mn",
        "https://mgpt.mn",
      ),
    ).toBe("https://dev.mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp")
  })

  test("does not redirect public pages or the canonical console", () => {
    expect(previewAuthRedirect("https://mgpt.mn/pricing", "https://dev.mgpt.mn", "https://mgpt.mn")).toBeUndefined()
    expect(previewAuthRedirect("https://dev.mgpt.mn/auth", "https://dev.mgpt.mn", "https://mgpt.mn")).toBeUndefined()
  })

  test("stays disabled when production uses the root domain", () => {
    expect(previewAuthRedirect("https://mgpt.mn/auth", "https://mgpt.mn", "https://mgpt.mn")).toBeUndefined()
  })

  test("fails closed for foreign and malformed origins", () => {
    expect(previewAuthRedirect("https://evil.example/auth", "https://dev.mgpt.mn", "https://mgpt.mn")).toBeUndefined()
    expect(previewAuthRedirect("https://mgpt.mn/auth", "javascript:alert(1)", "https://mgpt.mn")).toBeUndefined()
    expect(previewAuthRedirect("https://mgpt.mn/auth", "https://dev.mgpt.mn/path", "https://mgpt.mn")).toBeUndefined()
  })
})

describe("public www alias", () => {
  test("redirects the exact www host to the canonical root and preserves the request target", () => {
    expect(previewWwwRedirect("https://www.mgpt.mn/docs/?source=nav", "https://mgpt.mn")).toBe(
      "https://mgpt.mn/docs/?source=nav",
    )
  })

  test("does not redirect canonical, foreign, malformed, or mismatched-port requests", () => {
    expect(previewWwwRedirect("https://mgpt.mn/", "https://mgpt.mn")).toBeUndefined()
    expect(previewWwwRedirect("https://www.evil.example/", "https://mgpt.mn")).toBeUndefined()
    expect(previewWwwRedirect("https://www.mgpt.mn/", "javascript:alert(1)")).toBeUndefined()
    expect(previewWwwRedirect("https://www.mgpt.mn:8443/", "https://mgpt.mn")).toBeUndefined()
  })
})
