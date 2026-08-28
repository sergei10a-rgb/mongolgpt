import { describe, expect, test } from "bun:test"
import {
  readTurnstileAuthorizationSubmission,
  TURNSTILE_ACTION,
  TURNSTILE_TEST_SECRET_KEY,
  TURNSTILE_TEST_TOKEN,
  turnstileAuthorizationRequest,
  turnstileRetryUrl,
  verifyTurnstile,
} from "../src/turnstile"

const submission = {
  token: "verified-token",
  clientID: "app",
  redirectURI: "https://dev.mgpt.mn/auth/callback/auth/app?source=desktop",
  responseType: "code",
  state: "12345678-1234-1234-1234-123456789012",
}

const cliSubmission = {
  token: "verified-token",
  clientID: "mongolgpt-cli",
  redirectURI: "http://localhost:1456/auth/callback",
  responseType: "code",
  state: "vLrYftwvtNxLFfrx5VG9flLzW7Y8pw9e0sAPQnEPdgQ",
  codeChallenge: "r0Z3xQJf4wK8DZmTsCyuLgVbA9hN6pEeU2iO7sMxP1k",
  codeChallengeMethod: "S256",
}

describe("Cloudflare Turnstile OAuth protection", () => {
  test("validates a single-use token with the expected action and hostname", async () => {
    let posted: URLSearchParams | undefined
    const result = await verifyTurnstile({
      token: submission.token,
      secret: "verified-secret",
      expectedHostname: "dev.mgpt.mn",
      remoteIp: "203.0.113.9",
      fetcher: async (_input, init) => {
        if (!(init?.body instanceof URLSearchParams)) throw new Error("URL-encoded Siteverify body expected")
        posted = init.body
        return Response.json({ success: true, hostname: "dev.mgpt.mn", action: TURNSTILE_ACTION })
      },
    })

    expect(result).toEqual({ ok: true })
    expect(posted?.get("secret")).toBe("verified-secret")
    expect(posted?.get("response")).toBe(submission.token)
    expect(posted?.get("remoteip")).toBe("203.0.113.9")
  })

  test("fails closed for provider errors, action mismatch, and hostname mismatch", async () => {
    const base = { token: submission.token, secret: "verified-secret", expectedHostname: "dev.mgpt.mn" }
    expect(await verifyTurnstile({ ...base, fetcher: async () => new Response("error", { status: 503 }) })).toEqual({
      ok: false,
      reason: "provider_unavailable",
    })
    expect(
      await verifyTurnstile({
        ...base,
        fetcher: async () => Response.json({ success: true, hostname: "dev.mgpt.mn", action: "other" }),
      }),
    ).toEqual({ ok: false, reason: "invalid" })
    expect(
      await verifyTurnstile({
        ...base,
        fetcher: async () => Response.json({ success: true, hostname: "attacker.example", action: TURNSTILE_ACTION }),
      }),
    ).toEqual({ ok: false, reason: "invalid" })
  })

  test("accepts Cloudflare test validation without production-only metadata", async () => {
    const valid = await verifyTurnstile({
      token: TURNSTILE_TEST_TOKEN,
      secret: TURNSTILE_TEST_SECRET_KEY,
      expectedHostname: "dev.mgpt.mn",
      fetcher: async () => Response.json({ success: true, hostname: "example.com" }),
    })
    expect(valid).toEqual({ ok: true })

    const rejected = await verifyTurnstile({
      token: TURNSTILE_TEST_TOKEN,
      secret: TURNSTILE_TEST_SECRET_KEY,
      expectedHostname: "dev.mgpt.mn",
      fetcher: async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    })
    expect(rejected).toEqual({ ok: false, reason: "invalid" })
  })

  test("parses one bounded form and reconstructs only the approved OAuth request", async () => {
    const request = new Request("https://auth.dev.mgpt.mn/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "cf-turnstile-response": submission.token,
        client_id: submission.clientID,
        redirect_uri: submission.redirectURI,
        response_type: submission.responseType,
        state: submission.state,
      }),
    })
    const parsed = await readTurnstileAuthorizationSubmission(request)
    expect(parsed).toEqual(submission)
    if (!parsed) throw new Error("Turnstile submission was not parsed")
    expect(
      turnstileAuthorizationRequest({
        authUrl: "https://auth.dev.mgpt.mn/authorize",
        consoleOrigin: "https://dev.mgpt.mn",
        submission: parsed,
      }).toString(),
    ).toBe(
      "https://auth.dev.mgpt.mn/authorize?client_id=app&redirect_uri=https%3A%2F%2Fdev.mgpt.mn%2Fauth%2Fcallback%2Fauth%2Fapp%3Fsource%3Ddesktop&response_type=code&state=12345678-1234-1234-1234-123456789012",
    )
  })

  test("rejects duplicate fields, foreign callbacks, and direct OAuth mutation", async () => {
    const duplicate = new Request("https://auth.dev.mgpt.mn/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `cf-turnstile-response=${submission.token}&client_id=app&client_id=other&redirect_uri=${encodeURIComponent(submission.redirectURI)}&response_type=code&state=${submission.state}`,
    })
    expect(await readTurnstileAuthorizationSubmission(duplicate)).toBeUndefined()
    expect(() =>
      turnstileAuthorizationRequest({
        authUrl: "https://auth.dev.mgpt.mn/authorize",
        consoleOrigin: "https://dev.mgpt.mn",
        submission: { ...submission, redirectURI: "https://attacker.example/auth/callback" },
      }),
    ).toThrow("callback")
    expect(() =>
      turnstileAuthorizationRequest({
        authUrl: "https://auth.dev.mgpt.mn/authorize",
        consoleOrigin: "https://dev.mgpt.mn",
        submission: { ...submission, responseType: "token" },
      }),
    ).toThrow("client")
  })

  test("preserves the CLI PKCE request while allowing only the fixed loopback callback", () => {
    expect(
      turnstileAuthorizationRequest({
        authUrl: "https://auth.dev.mgpt.mn/authorize",
        consoleOrigin: "https://dev.mgpt.mn",
        submission: cliSubmission,
      }).toString(),
    ).toBe(
      "https://auth.dev.mgpt.mn/authorize?client_id=mongolgpt-cli&redirect_uri=http%3A%2F%2Flocalhost%3A1456%2Fauth%2Fcallback&response_type=code&state=vLrYftwvtNxLFfrx5VG9flLzW7Y8pw9e0sAPQnEPdgQ&code_challenge=r0Z3xQJf4wK8DZmTsCyuLgVbA9hN6pEeU2iO7sMxP1k&code_challenge_method=S256",
    )
    expect(() =>
      turnstileAuthorizationRequest({
        authUrl: "https://auth.dev.mgpt.mn/authorize",
        consoleOrigin: "https://dev.mgpt.mn",
        submission: { ...cliSubmission, redirectURI: "http://127.0.0.1:1456/auth/callback" },
      }),
    ).toThrow("CLI")
    expect(() =>
      turnstileAuthorizationRequest({
        authUrl: "https://auth.dev.mgpt.mn/authorize",
        consoleOrigin: "https://dev.mgpt.mn",
        submission: { ...cliSubmission, state: "state_with_base64url_underscore_123456" },
      }),
    ).not.toThrow()
  })

  test("returns a local retry URL without trusting an external continuation", () => {
    expect(turnstileRetryUrl({ consoleOrigin: "https://dev.mgpt.mn", submission, reason: "invalid" }).toString()).toBe(
      "https://dev.mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp%3Fsource%3Ddesktop&turnstile_error=invalid",
    )
    expect(
      turnstileRetryUrl({
        consoleOrigin: "https://dev.mgpt.mn",
        submission: cliSubmission,
        reason: "invalid",
      }).toString(),
    ).toBe(
      "https://dev.mgpt.mn/auth/authorize?client_id=mongolgpt-cli&redirect_uri=http%3A%2F%2Flocalhost%3A1456%2Fauth%2Fcallback&response_type=code&state=vLrYftwvtNxLFfrx5VG9flLzW7Y8pw9e0sAPQnEPdgQ&code_challenge=r0Z3xQJf4wK8DZmTsCyuLgVbA9hN6pEeU2iO7sMxP1k&code_challenge_method=S256&turnstile_error=invalid",
    )
  })
})
