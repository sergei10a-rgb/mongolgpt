import { describe, expect, test } from "bun:test"
import { hostedPreviewConfig, hostedPreviewOrigin, hostedPreviewRuntimeAudience } from "./hosted-preview"

const exactConfig = {
  enabled: true,
  hostedAppUrl: "https://app.dev.mgpt.mn",
  hostedRuntimeUrl: "https://runtime.dev.mgpt.mn",
  hostedConsoleUrl: "https://dev.mgpt.mn",
}

describe("hosted preview policy", () => {
  test("enables only the exact owner-only dev preview constellation", () => {
    expect(hostedPreviewConfig(exactConfig)).toEqual({
      origin: hostedPreviewOrigin,
      ownerEmail: "sergei10a@gmail.com",
    })
    expect(hostedPreviewConfig({ ...exactConfig, hostedAppUrl: "https://app.dev.mgpt.mn/" })).toBeUndefined()
    expect(hostedPreviewConfig({ ...exactConfig, hostedRuntimeUrl: "https://runtime.mgpt.mn" })).toBeUndefined()
    expect(hostedPreviewConfig({ ...exactConfig, hostedConsoleUrl: "https://mgpt.mn" })).toBeUndefined()
  })

  test("stays disabled when the opt-in flag is absent or the app is production", () => {
    expect(hostedPreviewConfig({ ...exactConfig, enabled: false })).toBeUndefined()
    expect(hostedPreviewConfig({ ...exactConfig, hostedAppUrl: "https://app.mgpt.mn" })).toBeUndefined()
  })

  test("maps only the exact preview request origin to the preview audience", () => {
    expect(
      hostedPreviewRuntimeAudience({
        ...exactConfig,
        requestOrigin: "https://preview.dev.mgpt.mn",
        accountEmail: "sergei10a@gmail.com",
      }),
    ).toEqual({ matched: true, status: "allowed", audience: hostedPreviewOrigin })

    expect(
      hostedPreviewRuntimeAudience({
        ...exactConfig,
        requestOrigin: "https://preview.dev.mgpt.mn.evil",
        accountEmail: "sergei10a@gmail.com",
      }),
    ).toEqual({ matched: false })
  })

  test("denies preview-origin runtime tokens for non-owner accounts and disabled configs", () => {
    expect(
      hostedPreviewRuntimeAudience({
        ...exactConfig,
        requestOrigin: "https://preview.dev.mgpt.mn",
        accountEmail: "other@example.com",
      }),
    ).toEqual({ matched: true, status: "forbidden" })
    expect(
      hostedPreviewRuntimeAudience({
        ...exactConfig,
        enabled: false,
        requestOrigin: "https://preview.dev.mgpt.mn",
        accountEmail: "sergei10a@gmail.com",
      }),
    ).toEqual({ matched: true, status: "disabled" })
  })
})
