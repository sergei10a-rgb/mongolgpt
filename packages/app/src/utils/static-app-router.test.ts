import { describe, expect, test } from "bun:test"
import {
  isStaticAppBackendPath,
  routeStaticAppRequest,
  staticAppBackendBoundaryPaths,
  staticAppBackendPrefixes,
  type StaticAssetsBinding,
} from "./static-app-router"

describe("static app router", () => {
  test("recognizes backend namespaces without rejecting app navigation", () => {
    for (const path of [
      "/api/health",
      "/auth/runtime-token",
      "/config",
      "/doc",
      "/global/health",
      "/session/status",
      "/v1/account/overview",
      "/workspace",
    ]) {
      expect(isStaticAppBackendPath(path)).toBe(true)
    }

    for (const path of [
      "/",
      "/new-session",
      "/server/local/session/abc",
      "/C%3A%5CCode/session/abc",
      "/assets/index.js",
      "/favicon.ico",
    ]) {
      expect(isStaticAppBackendPath(path)).toBe(false)
    }
  })

  test("keeps every reserved backend namespace in the deployment boundary probes", () => {
    const coveredPrefixes = new Set(
      staticAppBackendBoundaryPaths
        .map((path) => path.split("/", 3)[1])
        .filter((prefix): prefix is string => Boolean(prefix)),
    )

    expect(coveredPrefixes).toEqual(new Set(staticAppBackendPrefixes))
    expect(new Set(staticAppBackendBoundaryPaths).size).toBe(staticAppBackendBoundaryPaths.length)
    for (const path of staticAppBackendBoundaryPaths) expect(isStaticAppBackendPath(path)).toBe(true)
  })

  test("returns a non-cacheable JSON error instead of SPA HTML", async () => {
    let delegated = false
    const assets: StaticAssetsBinding = {
      async fetch() {
        delegated = true
        return new Response("<!doctype html>", { headers: { "content-type": "text/html" } })
      },
    }

    const response = await routeStaticAppRequest(new Request("https://app.dev.mgpt.mn/global/health"), assets)
    expect(delegated).toBe(false)
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await response.json()).toMatchObject({ code: "STATIC_APP_API_ROUTE" })
  })

  test("omits the body for HEAD and delegates app routes unchanged", async () => {
    const delegated: Request[] = []
    const assets: StaticAssetsBinding = {
      async fetch(request) {
        delegated.push(request)
        return new Response("app", { status: 200 })
      },
    }

    const head = await routeStaticAppRequest(
      new Request("https://app.dev.mgpt.mn/api/health", { method: "HEAD" }),
      assets,
    )
    expect(head.status).toBe(404)
    expect(await head.text()).toBe("")

    const request = new Request("https://app.dev.mgpt.mn/new-session")
    const response = await routeStaticAppRequest(request, assets)
    expect(await response.text()).toBe("app")
    expect(delegated).toEqual([request])
  })
})
