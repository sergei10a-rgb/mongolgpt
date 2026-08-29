import { describe, expect, test } from "bun:test"
import { renderTurnstileChallenge } from "./turnstile"

const authorizationUrl =
  "https://auth.dev.mgpt.mn/authorize?client_id=app&redirect_uri=https%3A%2F%2Fdev.mgpt.mn%2Fauth%2Fcallback%2Fauth%2Fapp&response_type=code&state=12345678-1234-1234-1234-123456789012"

describe("Turnstile OAuth challenge page", () => {
  test("posts the one-time token and exact OAuth request directly to the auth worker", () => {
    const result = renderTurnstileChallenge({
      siteKey: "1x00000000000000000000AA",
      scriptNonce: "testnonce1234567890",
      authorizationUrl,
      consoleOrigin: "https://dev.mgpt.mn",
      error: "invalid",
    })
    expect(result.authOrigin).toBe("https://auth.dev.mgpt.mn")
    expect(result.html).toContain('lang="mn"')
    expect(result.html).toContain('action="https://auth.dev.mgpt.mn/authorize" method="post"')
    expect(result.html).toContain('name="client_id" value="app"')
    expect(result.html).toContain('name="redirect_uri" value="https://dev.mgpt.mn/auth/callback/auth/app"')
    expect(result.html).toContain('name="response_type" value="code"')
    expect(result.html).toContain('name="state" value="12345678-1234-1234-1234-123456789012"')
    expect(result.html).toContain('data-action="mongolgpt_login"')
    expect(result.html).toContain('data-response-field="false"')
    expect(result.html).toContain('data-callback="mongolGPTTurnstileReady"')
    expect(result.html).toContain('data-expired-callback="mongolGPTTurnstileExpired"')
    expect(result.html).toContain('<button type="submit" disabled>Үргэлжлүүлэх</button>')
    expect(result.html).toContain('nonce="testnonce1234567890"')
    expect(result.html).toContain("Нэвтрэх үйлчилгээнд шилжүүлж байна...")
    expect(result.html).toContain('window.mongolGPTTurnstileReady = (token) =>')
    expect(result.html).toContain('let verifiedToken = ""')
    expect(result.html).toContain('form.addEventListener("formdata"')
    expect(result.html).toContain('event.formData.set("mongolgpt-turnstile-response", verifiedToken)')
    expect(result.html).toContain('verifiedToken = ""')
    expect(result.html).toContain("Хүний баталгаажуулалт амжилтгүй боллоо")
  })

  test("rejects unsafe auth origins and incomplete authorize requests", () => {
    expect(() =>
      renderTurnstileChallenge({
        siteKey: "1x00000000000000000000AA",
        scriptNonce: "testnonce1234567890",
        authorizationUrl: authorizationUrl.replace("https://auth", "http://auth"),
        consoleOrigin: "https://dev.mgpt.mn",
      }),
    ).toThrow("тохиргоо буруу")
    expect(() =>
      renderTurnstileChallenge({
        siteKey: "1x00000000000000000000AA",
        scriptNonce: "testnonce1234567890",
        authorizationUrl: authorizationUrl.replace(/&state=[^&]+/, ""),
        consoleOrigin: "https://dev.mgpt.mn",
      }),
    ).toThrow("дутуу")
  })

  test("keeps the Desktop and CLI PKCE fields in the protected form", () => {
    const result = renderTurnstileChallenge({
      siteKey: "1x00000000000000000000AA",
      scriptNonce: "testnonce1234567890",
      authorizationUrl:
        "https://auth.dev.mgpt.mn/authorize?client_id=mongolgpt-cli&redirect_uri=http%3A%2F%2Flocalhost%3A1456%2Fauth%2Fcallback&response_type=code&state=vLrYftwvtNxLFfrx5VG9flLzW7Y8pw9e0sAPQnEPdgQ&code_challenge=r0Z3xQJf4wK8DZmTsCyuLgVbA9hN6pEeU2iO7sMxP1k&code_challenge_method=S256",
      consoleOrigin: "https://dev.mgpt.mn",
    })
    expect(result.callbackOrigin).toBe("http://localhost:1456")
    expect(result.html).toContain('name="client_id" value="mongolgpt-cli"')
    expect(result.html).toContain('name="redirect_uri" value="http://localhost:1456/auth/callback"')
    expect(result.html).toContain('name="code_challenge" value="r0Z3xQJf4wK8DZmTsCyuLgVbA9hN6pEeU2iO7sMxP1k"')
    expect(result.html).toContain('name="code_challenge_method" value="S256"')
  })
})
