import { describe, expect, test } from "bun:test"
import {
  classifyDeployedResponse,
  isBenignDeployedConsoleError,
  parseSmokeAuthCookie,
  shouldObserveDeployedRequest,
  shouldWaitForDeployedRequest,
} from "./network"

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
  test("waits for product pages and assets while observing API boundaries separately", () => {
    const appOrigin = "https://app.dev.mgpt.mn"
    const publicOrigin = "https://dev.mgpt.mn"
    const runtimeOrigin = "https://runtime.dev.mgpt.mn"
    const apiOrigins = new Set([publicOrigin, runtimeOrigin])
    const pageOrigins = new Set([appOrigin, publicOrigin])
    const waits = (origin: string, pathname: string, resourceType: string) =>
      shouldWaitForDeployedRequest({ origin, pathname, resourceType }, pageOrigins)
    const observes = (origin: string, pathname: string, resourceType: string) =>
      shouldObserveDeployedRequest({ origin, pathname, resourceType }, appOrigin, apiOrigins, pageOrigins)

    expect(waits(appOrigin, "/", "document")).toBe(true)
    expect(waits(appOrigin, "/assets/index.js", "script")).toBe(true)
    expect(waits(publicOrigin, "/v1/account/overview", "fetch")).toBe(false)
    expect(waits(runtimeOrigin, "/auth/session", "fetch")).toBe(false)
    expect(waits(runtimeOrigin, "/project", "xhr")).toBe(false)

    expect(observes(publicOrigin, "/v1/account/overview", "fetch")).toBe(true)
    expect(observes(runtimeOrigin, "/auth/session", "fetch")).toBe(true)
    expect(observes(runtimeOrigin, "/project", "xhr")).toBe(true)

    expect(observes(runtimeOrigin, "/event", "fetch")).toBe(false)
    expect(observes(runtimeOrigin, "/global/event", "fetch")).toBe(false)
    expect(observes(runtimeOrigin, "/api/event", "fetch")).toBe(false)
    expect(observes(runtimeOrigin, "/api/session/session-1/event", "fetch")).toBe(false)
    expect(observes(appOrigin, "/cdn-cgi/rum", "fetch")).toBe(false)
    expect(observes("https://static.cloudflareinsights.com", "/beacon.min.js", "script")).toBe(false)
    expect(observes("https://telemetry.example", "/collect", "fetch")).toBe(false)
  })

  test("allows only expected anonymous API authorization errors in the console", () => {
    const appOrigin = "https://app.dev.mgpt.mn"
    const publicOrigin = "https://dev.mgpt.mn"
    const runtimeOrigin = "https://runtime.dev.mgpt.mn"
    const apiOrigins = new Set([publicOrigin, runtimeOrigin])
    const unauthorized = "Failed to load resource: the server responded with a status of 401 ()"

    expect(isBenignDeployedConsoleError(unauthorized, `${publicOrigin}/v1/account/overview`, appOrigin, apiOrigins)).toBe(
      true,
    )
    expect(isBenignDeployedConsoleError(unauthorized, `${runtimeOrigin}/project`, appOrigin, apiOrigins)).toBe(true)
    expect(isBenignDeployedConsoleError(unauthorized, `${appOrigin}/assets/index.js`, appOrigin, apiOrigins)).toBe(false)
    expect(
      isBenignDeployedConsoleError(
        "Failed to load resource: the server responded with a status of 500 ()",
        `${runtimeOrigin}/project`,
        appOrigin,
        apiOrigins,
      ),
    ).toBe(false)
  })

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
