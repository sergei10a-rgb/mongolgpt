import { describe, expect, test } from "bun:test"
import { checkNativeRuntimeToken } from "../../../script/deployment-smoke"

describe("native runtime token deployment boundary", () => {
  test("checks both non-browser and browser POSTs over HTTP without credentials", async () => {
    const origins: (string | null)[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/runtime-token")
        expect(request.method).toBe("POST")
        expect(request.headers.has("authorization")).toBe(false)
        expect(request.headers.has("cookie")).toBe(false)
        origins.push(request.headers.get("origin"))
        return rejection(request)
      },
    })
    await checkNativeRuntimeToken(server.url.toString(), "https://app.dev.mgpt.mn")
    expect(origins).toEqual([null, "https://app.dev.mgpt.mn"])
  })

  test("rejects static HTML, redirects, CORS, cached responses, wrong schema, and exposed tokens", async () => {
    for (const fetch of [
      () => new Response("<!doctype html><title>MongolGPT</title>", { headers: { "content-type": "text/html" } }),
      () =>
        new Response("<!doctype html><title>MongolGPT</title>", {
          status: 401,
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        }),
      () => Response.redirect("https://example.com/login", 302),
      (request: Request) => rejection(request, { "access-control-allow-origin": "*" }),
      (request: Request) => rejection(request, { "cache-control": "public" }),
      () => Response.json({ error: "unrelated" }, { status: 401, headers: { "cache-control": "no-store" } }),
      () =>
        Response.json(
          { error: "unauthorized", message: "Дахин нэвтэрнэ үү.", token: "must-not-be-present" },
          { status: 401, headers: { "cache-control": "no-store" } },
        ),
    ]) {
      using server = Bun.serve({ port: 0, fetch })
      await expect(checkNativeRuntimeToken(server.url.toString(), "https://app.dev.mgpt.mn")).rejects.toBeInstanceOf(
        Error,
      )
    }
  })
})

function rejection(request: Request, extra: Record<string, string> = {}) {
  const browser = request.headers.has("origin")
  return Response.json(
    { error: browser ? "invalid_origin" : "unauthorized", message: "Дахин нэвтэрнэ үү." },
    { status: browser ? 403 : 401, headers: { "cache-control": "no-store", ...extra } },
  )
}
