import { describe, expect, test } from "bun:test"
import {
  captureOAuthClientState,
  captureOAuthFlow,
  clearOAuthFlowCookie,
  restoreOAuthClientState,
  restoreOAuthFlowRequest,
} from "../src/oauth-flow-state"

function authorizationRequest(authorization: string, clientState?: string) {
  const clientCookie = clientState ? `; __Host-mongolgpt-oauth-client-${clientState}=${authorization}` : ""
  return new Request("https://auth.dev.mgpt.mn/github/authorize", {
    headers: { cookie: `theme=dark; authorization=${authorization}${clientCookie}` },
  })
}

function providerResponse(state: string, provider: string) {
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://github.com/login/oauth/authorize?state=${state}`,
      "set-cookie": `provider=${provider}; Max-Age=600; HttpOnly; Secure; SameSite=None`,
    },
  })
}

function flowCookie(response: Response, state: string) {
  const setCookies = readSetCookies(response)
  const prefix = `__Host-mongolgpt-oauth-github-${state}=`
  const header = setCookies.find((value) => value.startsWith(prefix))
  if (!header) throw new Error("flow cookie missing")
  return header.slice(0, header.indexOf(";"))
}

function readSetCookies(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  return headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""]
}

describe("OAuth flow state isolation", () => {
  test("binds the original client state to the encrypted authorization cookie", () => {
    const request = new Request(
      "https://auth.dev.mgpt.mn/authorize?client_id=mongolgpt-cli&state=client-state-one-1234567890",
    )
    const response = new Response(null, {
      status: 200,
      headers: {
        "set-cookie": "authorization=encrypted-authorization-one; Secure; HttpOnly",
      },
    })

    const captured = captureOAuthClientState(request, response)

    expect(readSetCookies(captured).join("\n")).toContain(
      "__Host-mongolgpt-oauth-client-client-state-one-1234567890=encrypted-authorization-one; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None",
    )
  })

  test("captures concurrent provider redirects in distinct secure cookies", () => {
    const first = captureOAuthFlow(
      authorizationRequest("encrypted-authorization-one", "client-state-one-1234567890"),
      providerResponse("flow-one", "encrypted-provider-one"),
    )
    const second = captureOAuthFlow(
      authorizationRequest("encrypted-authorization-two", "client-state-two-1234567890"),
      providerResponse("flow-two", "encrypted-provider-two"),
    )

    expect(flowCookie(first, "flow-one")).not.toBe(flowCookie(second, "flow-two"))
    expect(readSetCookies(first).join("\n")).toContain("Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None")
    expect(readSetCookies(second).join("\n")).toContain("Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None")
    expect(readSetCookies(first).join("\n")).toContain(
      "__Host-mongolgpt-oauth-client-client-state-one-1234567890=; Max-Age=0",
    )
  })

  test("restores the matching flow without dropping unrelated cookies", () => {
    const captured = captureOAuthFlow(
      authorizationRequest("encrypted-authorization-one", "client-state-one-1234567890"),
      providerResponse("flow-one", "encrypted-provider-one"),
    )
    const request = new Request("https://auth.dev.mgpt.mn/github/callback?code=code-one&state=flow-one", {
      headers: {
        cookie: `${flowCookie(captured, "flow-one")}; theme=dark; authorization=encrypted-authorization-two; provider=encrypted-provider-two`,
      },
    })

    const restored = restoreOAuthFlowRequest(request)

    expect(restored.cleanupCookie).toBe("__Host-mongolgpt-oauth-github-flow-one")
    expect(restored.clientState).toBe("client-state-one-1234567890")
    expect(restored.request.headers.get("cookie")).toContain("theme=dark")
    expect(restored.request.headers.get("cookie")).toContain("authorization=encrypted-authorization-one")
    expect(restored.request.headers.get("cookie")).toContain("provider=encrypted-provider-one")
    expect(restored.request.headers.get("cookie")).not.toContain("authorization=encrypted-authorization-two")
  })

  test("fails closed for malformed, oversized, and non-callback state", () => {
    const malformedName = "__Host-mongolgpt-oauth-github-malformed"
    const malformed = restoreOAuthFlowRequest(
      new Request("https://auth.dev.mgpt.mn/github/callback?code=code&state=malformed", {
        headers: { cookie: `${malformedName}=not-base64; authorization=current; provider=current` },
      }),
    )
    expect(malformed.request.headers.get("cookie")).toContain("authorization=current")
    expect(malformed.cleanupCookie).toBe(malformedName)

    const ignored = restoreOAuthFlowRequest(
      new Request(`https://auth.dev.mgpt.mn/github/callback?state=${"x".repeat(129)}`),
    )
    expect(ignored.cleanupCookie).toBeUndefined()

    const direct = restoreOAuthFlowRequest(new Request("https://auth.dev.mgpt.mn/authorize?state=malformed"))
    expect(direct.cleanupCookie).toBeUndefined()
  })

  test("does not persist a flow without both encrypted OpenAuth cookies", () => {
    const request = new Request("https://auth.dev.mgpt.mn/google/authorize")
    const response = new Response(null, {
      status: 302,
      headers: {
        location: "https://accounts.google.com/o/oauth2/v2/auth?state=google-flow",
        "set-cookie": "provider=encrypted-provider; Secure; HttpOnly",
      },
    })

    expect(captureOAuthFlow(request, response)).toBe(response)
  })

  test("refuses an oversized browser cookie", () => {
    const request = authorizationRequest("a".repeat(3_000))
    const response = providerResponse("large-flow", "p".repeat(3_000))

    expect(captureOAuthFlow(request, response)).toBe(response)
  })

  test("clears the state-specific cookie after callback handling", () => {
    const response = clearOAuthFlowCookie(new Response(null, { status: 302 }), "__Host-mongolgpt-oauth-github-flow-one")
    expect(readSetCookies(response)).toEqual([
      "__Host-mongolgpt-oauth-github-flow-one=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None",
    ])
  })

  test("restores a missing client state on an OAuth error redirect", () => {
    const response = restoreOAuthClientState(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:45678/auth/callback?error=invalid_grant" },
      }),
      "client-state-one-1234567890",
    )
    const location = new URL(response.headers.get("location")!)

    expect(location.searchParams.get("state")).toBe("client-state-one-1234567890")
    expect(location.searchParams.get("error")).toBe("invalid_grant")
  })
})
