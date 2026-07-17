import { describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin } from "./cors"

describe("MongolGPT browser origin policy", () => {
  test("allows only the owned public app hosts", () => {
    expect(isAllowedCorsOrigin("https://app.mgpt.mn")).toBe(true)
    expect(isAllowedCorsOrigin("https://app.dev.mgpt.mn")).toBe(true)
    expect(isAllowedCorsOrigin("https://app.beta.mgpt.mn")).toBe(true)
    expect(isAllowedCorsOrigin("https://app.vimtor.mgpt.mn")).toBe(true)

    expect(isAllowedCorsOrigin("https://docs.mgpt.mn")).toBe(false)
    expect(isAllowedCorsOrigin("https://evil.mgpt.mn")).toBe(false)
    expect(isAllowedCorsOrigin("https://app.preview.evil.mgpt.mn")).toBe(false)
    expect(isAllowedCorsOrigin("https://app.mgpt.mn.evil.example")).toBe(false)
    expect(isAllowedCorsOrigin("https://app.mongolgpt.ai")).toBe(false)
  })
})
