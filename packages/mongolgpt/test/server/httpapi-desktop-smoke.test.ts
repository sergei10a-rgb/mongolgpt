import { afterEach, describe, expect, test } from "bun:test"
import {
  desktopSmokeOauthCallbackDocument,
  desktopSmokeOauthErrorPath,
  desktopSmokeOauthSuccessPath,
} from "../../src/server/routes/instance/httpapi/desktop-smoke"
import { configureDesktopSmokeProof } from "../../src/server/routes/instance/httpapi/middleware/account-use"

const proof = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

afterEach(() => configureDesktopSmokeProof(undefined))

describe("desktop packaged OAuth callback smoke", () => {
  test("renders the packaged sidecar callback pages only with the exact proof", () => {
    configureDesktopSmokeProof(proof)

    const success = desktopSmokeOauthCallbackDocument(desktopSmokeOauthSuccessPath, proof)
    const error = desktopSmokeOauthCallbackDocument(desktopSmokeOauthErrorPath, proof)

    expect(success).toContain('<html lang="mn">')
    expect(success).toContain("<title>Зөвшөөрөл амжилттай - MongolGPT</title>")
    expect(success).toContain("MongolGPT бүртгэл амжилттай холбогдлоо.")
    expect(error).toContain("<title>Зөвшөөрөл амжилтгүй - MongolGPT</title>")
    expect(error).toContain("Desktop OAuth callback smoke")
    expect(success?.toLowerCase()).not.toContain("opencode")
    expect(error?.toLowerCase()).not.toContain("opencode")

    expect(desktopSmokeOauthCallbackDocument(desktopSmokeOauthSuccessPath, `${proof}x`)).toBeUndefined()
    expect(desktopSmokeOauthCallbackDocument("/_internal/desktop-smoke/oauth-callback/other", proof)).toBeUndefined()
  })

  test("stays disabled outside an active packaged smoke", () => {
    expect(desktopSmokeOauthCallbackDocument(desktopSmokeOauthSuccessPath, proof)).toBeUndefined()
  })
})
