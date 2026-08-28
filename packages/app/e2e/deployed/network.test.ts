import { describe, expect, test } from "bun:test"
import { classifyDeployedResponse, parseSmokeAuthCookie } from "./network"

const origin = "https://dev.mgpt.mn"
const token = "authenticated-smoke-token-value"

describe("deployed browser auth cookie", () => {
  test("creates one host-only secure cookie without exposing the token in metadata", () => {
    expect(parseSmokeAuthCookie(`__Host-mongolgpt-auth=${token}`, origin)).toEqual({
      name: "__Host-mongolgpt-auth",
      value: token,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })
  })

  test("rejects cookie headers, attributes, weak tokens, and non-HTTPS origins", () => {
    for (const value of [
      `Cookie: __Host-mongolgpt-auth=${token}`,
      `__Host-mongolgpt-auth=${token}; Path=/`,
      `__Host-mongolgpt-auth=${token} `,
      "__Host-mongolgpt-auth=short",
      `other=${token}`,
    ]) {
      expect(() => parseSmokeAuthCookie(value, origin)).toThrow()
    }
    expect(() => parseSmokeAuthCookie(`__Host-mongolgpt-auth=${token}`, "http://dev.mgpt.mn")).toThrow()
  })

  test("never includes the secret token in validation errors", () => {
    const secret = `${token};Path=/`
    try {
      parseSmokeAuthCookie(`__Host-mongolgpt-auth=${secret}`, origin)
      throw new Error("expected cookie validation to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret)
    }
  })
})

describe("deployed multi-origin browser observer", () => {
  test("monitors the public console without treating its API calls as static-app misrouting", () => {
    const appOrigin = "https://app.dev.mgpt.mn"
    const apiOrigins = new Set(["https://dev.mgpt.mn"])
    const pageOrigins = new Set([appOrigin, "https://dev.mgpt.mn"])
    const api = classifyDeployedResponse(
      {
        origin: "https://dev.mgpt.mn",
        method: "GET",
        pathname: "/v1/account/overview",
        status: 200,
        contentType: "application/json",
        cacheControl: "no-store",
        resourceType: "fetch",
        url: "https://dev.mgpt.mn/v1/account/overview",
      },
      appOrigin,
      apiOrigins,
      pageOrigins,
    )
    expect(api.failedRequests).toEqual([])
    expect(api.htmlResponses).toEqual([])
    expect(api.observedApiResponses).toEqual([
      {
        origin: "https://dev.mgpt.mn",
        method: "GET",
        pathname: "/v1/account/overview",
        status: 200,
        contentType: "application/json",
        cacheControl: "no-store",
      },
    ])

    const document = classifyDeployedResponse(
      {
        origin: "https://dev.mgpt.mn",
        method: "GET",
        pathname: "/workspace/wrk_smoke/usage",
        status: 500,
        contentType: "text/html",
        cacheControl: "no-store",
        resourceType: "document",
        url: "https://dev.mgpt.mn/workspace/wrk_smoke/usage",
      },
      appOrigin,
      apiOrigins,
      pageOrigins,
    )
    expect(document.failedRequests).toEqual(["document:500 https://dev.mgpt.mn/workspace/wrk_smoke/usage"])
    expect(document.htmlResponses).toEqual([])
    expect(document.observedApiResponses).toEqual([])
  })
})
