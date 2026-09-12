import { describe, expect, test } from "bun:test"
import { provideRequestEvent } from "solid-js/web/storage"
import type { RequestEvent } from "solid-js/web"
import { adminActionFeedback, adminResponse, adminResponseError } from "../src/lib/admin-response"

function request<T>(path: string, run: () => T) {
  // The transport reads only the request, not SolidStart's native response context.
  return provideRequestEvent(
    { request: new Request(`http://admin.example.test${path}`), locals: {} } as RequestEvent,
    run,
  )
}

describe("admin data-only server responses", () => {
  test("action feedback is empty only before a response or error arrives", () => {
    expect(adminActionFeedback(undefined)).toBeUndefined()
    expect(adminActionFeedback({ ok: true, message: "Хадгаллаа." })).toEqual({ ok: true, message: "Хадгаллаа." })
    expect(adminActionFeedback({ ok: false, message: "Төлөв өөрчлөгдсөн байна." })).toEqual({
      ok: false,
      message: "Төлөв өөрчлөгдсөн байна.",
    })
  })

  test("malformed or lost action responses never become blank or successful feedback", () => {
    for (const result of [
      null,
      false,
      0,
      "",
      "upstream failed",
      [],
      {},
      { ok: true },
      { ok: true, message: " " },
      { ok: "true", message: "wrong type" },
    ]) {
      expect(adminActionFeedback(result)).toEqual({ ok: false, message: adminResponseError })
    }
    for (const error of [null, new Error("synthetic-secret"), "raw transport error", false]) {
      expect(adminActionFeedback(undefined, error)).toEqual({ ok: false, message: adminResponseError })
      expect(adminActionFeedback({ ok: true, message: "Stale success" }, error)).toEqual({
        ok: false,
        message: adminResponseError,
      })
    }
  })

  test("SSR keeps native values instead of replacing the document content type", async () => {
    const value = { ok: true, message: "Идэвхтэй", date: new Date(0) }
    const result = await request("/users", () => adminResponse(async () => value))
    expect(result).toBe(value)
    expect(result).not.toBeInstanceOf(Response)
  })

  test("RPC uses raw JSON without Referer, eval or single-flight revalidation", async () => {
    const value = { ok: false, message: "Хуудсаа шинэчилж шалгана уу.", rows: [1, null, true] }
    const result = await request("/_server", () => adminResponse(async () => value))
    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error("Expected an RPC response")
    expect(result.status).toBe(200)
    expect(result.headers.get("content-type")?.split(";")[0]).toBe("application/json")
    expect(result.headers.get("x-content-raw")).toBe("true")
    expect(result.headers.has("x-single-flight")).toBe(false)
    expect(result.headers.has("x-revalidate")).toBe(false)
    expect(result.headers.has("x-error")).toBe(false)
    expect(await result.json()).toEqual(value)
  })

  test("RPC exceptions use a redacted JSON failure and never replay the operation", async () => {
    let calls = 0
    const result = await request("/_server", () =>
      adminResponse(async () => {
        calls++
        throw new Error("synthetic-private-backend-detail")
      }),
    )
    expect(calls).toBe(1)
    if (!(result instanceof Response)) throw new Error("Expected an RPC response")
    expect(result.status).toBe(500)
    expect(result.headers.get("x-error")).toBe("true")
    expect(result.headers.get("x-content-raw")).toBe("true")
    expect(await result.json()).toEqual({ message: adminResponseError })
  })

  test("serialization failure after an operation never retries the operation", async () => {
    let calls = 0
    const result = await request("/_server", () =>
      adminResponse(async () => {
        calls++
        return { unsupported: 1n }
      }),
    )
    expect(calls).toBe(1)
    if (!(result instanceof Response)) throw new Error("Expected an RPC response")
    expect(result.status).toBe(500)
    expect(await result.json()).toEqual({ message: adminResponseError })
  })

  test("SSR errors propagate to the document error handler", async () => {
    const failure = new Error("Synthetic SSR failure")
    await expect(
      request("/users", () =>
        adminResponse(async () => {
          throw failure
        }),
      ),
    ).rejects.toBe(failure)
  })

  test("overlapping SSR and RPC requests retain their own request context", async () => {
    const ssr = request("/users", () =>
      adminResponse(async () => {
        await Bun.sleep(5)
        return { source: "SSR" }
      }),
    )
    const rpc = request("/_server?id=synthetic", () => adminResponse(async () => ({ source: "RPC" })))
    expect(await ssr).toEqual({ source: "SSR" })
    const response = await rpc
    if (!(response instanceof Response)) throw new Error("Expected an RPC response")
    expect(await response.json()).toEqual({ source: "RPC" })
  })
})
