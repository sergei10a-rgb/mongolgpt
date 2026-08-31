import { describe, expect, test } from "bun:test"
import { isAllowedStatsProxyRequest } from "./stats-proxy"
import { publicProxyRequestHeaders } from "./public-proxy-headers"

describe("public proxy request headers", () => {
  test("forwards only content negotiation, cache validation, range, and body type headers", () => {
    const headers = publicProxyRequestHeaders(
      new Headers({
        accept: "text/html",
        authorization: "Bearer must-not-leak",
        "cache-control": "no-cache",
        "cf-connecting-ip": "203.0.113.9",
        "content-type": "multipart/form-data; boundary=example",
        cookie: "__Host-mongolgpt-auth=must-not-leak",
        "if-none-match": '"asset"',
        range: "bytes=0-10",
        referer: "https://dev.mgpt.mn/account",
        "x-forwarded-for": "203.0.113.9",
        "x-mongolgpt-locale": "en",
      }),
    )

    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/html",
      "cache-control": "no-cache",
      "content-type": "multipart/form-data; boundary=example",
      "if-none-match": '"asset"',
      range: "bytes=0-10",
    })
    expect(JSON.stringify(Object.fromEntries(headers))).not.toContain("must-not-leak")
  })

  test("keeps docs read-only and exposes only the stats newsletter mutation", async () => {
    const [docsIndex, docsPath, docsProxy, dataIndex, dataPath, statsIndex, statsPath, statsProxy] = await Promise.all([
      Bun.file(new URL("../routes/docs/index.ts", import.meta.url)).text(),
      Bun.file(new URL("../routes/docs/[...path].ts", import.meta.url)).text(),
      Bun.file(new URL("../routes/docs/proxy.ts", import.meta.url)).text(),
      Bun.file(new URL("../routes/data/index.ts", import.meta.url)).text(),
      Bun.file(new URL("../routes/data/[...path].ts", import.meta.url)).text(),
      Bun.file(new URL("../routes/stats/index.ts", import.meta.url)).text(),
      Bun.file(new URL("../routes/stats/[...path].ts", import.meta.url)).text(),
      Bun.file(new URL("./stats-proxy.ts", import.meta.url)).text(),
    ])

    for (const source of [docsIndex, docsPath]) {
      expect(source).toContain("export const GET")
      expect(source).toContain("export const HEAD")
      expect(source).not.toMatch(/export const (?:POST|PUT|DELETE|PATCH|OPTIONS)/)
    }
    for (const source of [dataIndex, dataPath, statsIndex, statsPath]) {
      expect(source).toContain("export const GET")
      expect(source).toContain("export const HEAD")
      expect(source).toContain("export const POST")
      expect(source).not.toMatch(/export const (?:PUT|DELETE|PATCH|OPTIONS)/)
    }
    for (const source of [docsProxy, statsProxy]) {
      expect(source).toContain("publicProxyRequestHeaders(req.headers)")
      expect(source).not.toContain("new Headers(req.headers)")
    }
  })

  test("allows stats writes only for newsletter subscriptions", () => {
    expect(isAllowedStatsProxyRequest("GET", "/data/openai/gpt-5")).toBe(true)
    expect(isAllowedStatsProxyRequest("HEAD", "/data/openai/gpt-5")).toBe(true)
    expect(isAllowedStatsProxyRequest("POST", "/data/api/newsletter")).toBe(true)
    expect(isAllowedStatsProxyRequest("POST", "/data/api/health")).toBe(false)
    expect(isAllowedStatsProxyRequest("POST", "/data/anything-else")).toBe(false)
    expect(isAllowedStatsProxyRequest("PUT", "/data/api/newsletter")).toBe(false)
  })
})
