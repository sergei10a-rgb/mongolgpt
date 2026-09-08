import { describe, expect, spyOn, test } from "bun:test"
import { adminServiceRequest, fetchAdminService, resolveAdminServiceURL } from "../src/lib/admin-service"

describe("admin service URL", () => {
  test("resolves a bounded path against an HTTPS service origin", () => {
    expect(resolveAdminServiceURL({ url: "https://quota.example.com" }, "/v1/ledger").href).toBe(
      "https://quota.example.com/v1/ledger",
    )
  })

  test.each([
    ["http://quota.example.com", "/health"],
    ["https://user:password@quota.example.com", "/health"],
    ["https://quota.example.com:8443", "/health"],
    ["https://quota.example.com/base", "/health"],
    ["https://quota.example.com?next=evil", "/health"],
    ["https://quota.example.com", "//evil.example.com"],
    ["https://quota.example.com", "/\\evil.example.com"],
    ["https://quota.example.com", "health"],
    ["https://quota.example.com", "/health\r\nX-Test: yes"],
  ])("rejects unsafe service URL input: %s %s", (url, path) => {
    expect(() => resolveAdminServiceURL({ url }, path)).toThrow()
  })

  test("service fetch refuses redirects even when a caller requests follow mode", () => {
    const request = adminServiceRequest({ url: "https://quota.example.com" }, "/health", { redirect: "follow" })
    expect(request.url.href).toBe("https://quota.example.com/health")
    expect(request.init.redirect).toBe("manual")
  })

  test("rejects every 3xx without replaying admin mutations or exposing redirect content", async () => {
    for (let status = 300; status < 400; status++) {
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("private-response-body"))
        },
        cancel() {
          cancelled = true
        },
      })
      const fetcher = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
            expect(String(input)).toBe("https://payment.example.com/v1/admin/refund")
            expect(init?.redirect).toBe("manual")
            expect(init?.method).toBe("POST")
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-admin-token")
            return new Response(status === 304 ? null : stream, {
              status,
              headers: { location: "https://redirect.invalid/private-location?token=private-token" },
            })
          },
          { preconnect() {} },
        ),
      )
      try {
        const error = await fetchAdminService({ url: "https://payment.example.com" }, "/v1/admin/refund", {
          method: "POST",
          headers: { authorization: "Bearer synthetic-admin-token" },
          body: "synthetic-refund",
          redirect: "follow",
        }).catch((cause: unknown) => cause)
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toBe("Error: Admin service redirects are forbidden")
        expect(fetcher).toHaveBeenCalledTimes(1)
        if (status !== 304) expect(cancelled).toBe(true)
      } finally {
        fetcher.mockRestore()
      }
    }
  })

  test("rejects promptly when redirect body cancellation never settles", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
          return new Promise<void>(() => {})
        },
      }),
      { status: 307, headers: { location: "https://redirect.invalid/private-location" } },
    )
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(response)
    try {
      await expect(fetchAdminService({ url: "https://quota.example.com" }, "/health")).rejects.toThrow(
        "Admin service redirects are forbidden",
      )
      expect(cancelled).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.mockRestore()
    }
  }, 1000)

  test("preserves non-redirect responses for existing caller failure handling", async () => {
    for (const status of [200, 400, 503]) {
      const response = new Response("synthetic-response", { status })
      const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(response)
      try {
        expect(await fetchAdminService({ url: "https://quota.example.com" }, "/health")).toBe(response)
        expect(fetcher).toHaveBeenCalledTimes(1)
      } finally {
        fetcher.mockRestore()
      }
    }
  })
})
