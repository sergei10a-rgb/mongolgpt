import { describe, expect } from "bun:test"
import { Effect } from "effect"
import stripAnsi from "strip-ansi"
import { createHash } from "node:crypto"
import { cliIt } from "../lib/cli-process"

type OAuthCapture = {
  authorize?: URL
  token?: URLSearchParams
  userAuthorization?: string | null
  orgAuthorization?: string | null
}

function startAccountServer() {
  const capture: OAuthCapture = {}
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
        })
      }
      if (url.pathname === "/authorize") {
        capture.authorize = url
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
        redirect.searchParams.set("code", "cli-oauth-code")
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "")
        return Response.redirect(redirect, 302)
      }
      if (url.pathname === "/token") {
        capture.token = new URLSearchParams(await request.text())
        return Response.json({
          access_token: "cli-access-token",
          refresh_token: "cli-refresh-token",
          expires_in: 3_600,
        })
      }
      if (url.pathname === "/api/user") {
        capture.userAuthorization = request.headers.get("authorization")
        return Response.json({ id: "acc_cli_oauth", email: "cli@example.com" })
      }
      if (url.pathname === "/api/orgs") {
        capture.orgAuthorization = request.headers.get("authorization")
        return Response.json([{ id: "wrk_cli_oauth", name: "CLI туршилтын орчин" }])
      }
      return new Response(null, { status: 404 })
    },
  })
  return {
    capture,
    server,
    url: `http://127.0.0.1:${server.port}`,
  }
}

describe("mongolgpt account login subprocess", () => {
  cliIt.live(
    "completes browser OAuth with PKCE and persists the active workspace",
    ({ mongolgpt }) =>
      Effect.gen(function* () {
        const account = yield* Effect.acquireRelease(Effect.sync(startAccountServer), ({ server }) =>
          Effect.sync(() => server.stop(true)),
        )
        const tokenKey = Buffer.alloc(32, 19).toString("base64url")
        const env = { MONGOLGPT_ACCOUNT_TOKEN_KEY: tokenKey }
        const login = yield* mongolgpt.start(["account", "login", account.url, "--no-browser"], { env })

        const pending = stripAnsi(yield* login.waitForOutput(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/, 20_000))
        const authorizationUrl = pending.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/)?.[0]
        expect(authorizationUrl).toBeDefined()

        const callback = yield* Effect.promise(() => fetch(authorizationUrl as string))
        expect(callback.status).toBe(200)
        expect(callback.headers.get("content-type")).toContain("text/html")

        const result = yield* login.result
        mongolgpt.expectExit(result, 0, "mongolgpt account login --no-browser")
        const output = stripAnsi(result.stdout + result.stderr)
        expect(output).toContain("cli@example.com нэрээр нэвтэрлээ")
        expect(output).toContain("Бүртгэлээр нэвтэрсний дараа MongolGPT Free Auto анхдагчаар идэвхжинэ.")
        expect(output).toContain("Дууслаа")

        expect(account.capture.authorize?.searchParams.get("client_id")).toBe("mongolgpt-cli")
        expect(account.capture.authorize?.searchParams.get("response_type")).toBe("code")
        expect(account.capture.authorize?.searchParams.get("code_challenge_method")).toBe("S256")
        const challenge = account.capture.authorize?.searchParams.get("code_challenge")
        if (!challenge) throw new Error("OAuth PKCE challenge дутуу байна")
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(account.capture.token?.get("grant_type")).toBe("authorization_code")
        expect(account.capture.token?.get("code")).toBe("cli-oauth-code")
        const verifier = account.capture.token?.get("code_verifier")
        if (!verifier) throw new Error("OAuth PKCE verifier дутуу байна")
        expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge)
        expect(account.capture.userAuthorization).toBe("Bearer cli-access-token")
        expect(account.capture.orgAuthorization).toBe("Bearer cli-access-token")

        const orgs = yield* mongolgpt.spawn(["account", "orgs"], { env })
        mongolgpt.expectExit(orgs, 0, "mongolgpt account orgs")
        expect(stripAnsi(orgs.stdout + orgs.stderr)).toContain("● CLI туршилтын орчин")
      }),
    60_000,
  )
})
