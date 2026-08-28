import { describe, expect, test } from "bun:test"
import { publicMetadataBaseUrl } from "../src/lib/public-metadata"

describe("public metadata base URL", () => {
  test("uses the root origin when the incoming request matches the public root alias exactly", () => {
    expect(
      publicMetadataBaseUrl("https://mgpt.mn/mn/pricing", "https://dev.mgpt.mn", "https://mgpt.mn"),
    ).toBe("https://mgpt.mn")
  })

  test("keeps the configured public origin for canonical dev requests", () => {
    expect(
      publicMetadataBaseUrl("https://dev.mgpt.mn/mn/pricing", "https://dev.mgpt.mn", "https://mgpt.mn"),
    ).toBe("https://dev.mgpt.mn")
  })

  test("falls back cleanly when root metadata switching is not applicable", () => {
    expect(publicMetadataBaseUrl("not-a-url", "https://dev.mgpt.mn", "javascript:alert(1)")).toBe(
      "https://dev.mgpt.mn",
    )
    expect(publicMetadataBaseUrl("https://mgpt.mn/", undefined, "https://mgpt.mn")).toBe("https://mgpt.mn")
  })
})
