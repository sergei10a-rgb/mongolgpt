import { describe, expect, test } from "bun:test"
import { collectCanaryFailureDiagnostics } from "../script/test-cloudflare-canary"
import { emptyCanaryDiagnostics, type CanaryDiagnostics } from "../script/canary-diagnostics"

const origin = "https://mgpt-canary-123-1.example.workers.dev"
const adminToken = "a".repeat(64)

describe("canary failure diagnostic collection", () => {
  test("preserves only validated metadata from a successful diagnostic response", async () => {
    const expected = {
      ...emptyCanaryDiagnostics(),
      bootCount: 1,
      containerStatus: "healthy",
      epoch: 0,
      checkpointPresent: false,
      revisionPresent: false,
    } satisfies CanaryDiagnostics
    const result = await collectCanaryFailureDiagnostics({
      origin,
      adminToken,
      request: async () => Response.json({ ...expected, token: "private-extra-field", logs: "private-log" }),
    })
    expect(result).toEqual(expected)
    expect(JSON.stringify(result)).not.toContain("private-")
  })

  test("only sends a read to the exact isolated control endpoint", async () => {
    let calls = 0
    const result = await collectCanaryFailureDiagnostics({
      origin,
      adminToken,
      async request(url, init) {
        calls++
        expect(url).toBe(`${origin}/__canary/diagnostics`)
        expect(init?.method).toBe("GET")
        expect(init?.body).toBeUndefined()
        expect(init?.redirect).toBe("error")
        expect(new Headers(init?.headers).get("x-mongolgpt-canary-token")).toBe(adminToken)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return new Response("private server error", { status: 500 })
      },
    })
    expect(calls).toBe(1)
    expect(result).toBeUndefined()
  })

  test("rejects foreign origins and invalid credentials before any request", async () => {
    for (const value of [
      { origin: "https://runtime.dev.mgpt.mn", adminToken },
      { origin: `${origin}/other`, adminToken },
      { origin: origin.replace("https:", "http:"), adminToken },
      { origin, adminToken: "short" },
      { origin, adminToken: `${adminToken}\n` },
    ]) {
      let calls = 0
      expect(
        await collectCanaryFailureDiagnostics({
          ...value,
          async request() {
            calls++
            throw new Error("must not send credentials")
          },
        }),
      ).toBeUndefined()
      expect(calls).toBe(0)
    }
  })

  test("suppresses network exceptions and malformed private response content", async () => {
    const privateValue = "private-credential-do-not-report"
    for (const request of [
      async () => {
        throw new Error(privateValue)
      },
      async () => new Response(privateValue, { headers: { "content-type": "application/json" } }),
      async () => Response.json({ message: privateValue, token: privateValue, stderr: privateValue }),
      async () => Response.json({ message: privateValue.repeat(10_000) }),
    ]) {
      const result = await collectCanaryFailureDiagnostics({ origin, adminToken, request })
      expect(JSON.stringify(result ?? null)).not.toContain(privateValue)
      expect(result).toBeUndefined()
    }
  })

  test("an aborted request cannot block cleanup even if transport ignores abort", async () => {
    const controller = new AbortController()
    let started = false
    const pending = collectCanaryFailureDiagnostics({
      origin,
      adminToken,
      signal: controller.signal,
      request: async () => {
        started = true
        return new Promise<Response>(() => {})
      },
    })
    controller.abort(new Error("private abort reason"))
    expect(await pending).toBeUndefined()
    expect(started).toBe(true)
  })

  test("aborts a stalled response body without reporting private data", async () => {
    const controller = new AbortController()
    const bodyRead = Promise.withResolvers<void>()
    let cancelled = false
    const pending = collectCanaryFailureDiagnostics({
      origin,
      adminToken,
      signal: controller.signal,
      request: async () =>
        new Response(
          new ReadableStream({
            pull() {
              bodyRead.resolve()
              return new Promise<void>(() => {})
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    })
    await bodyRead.promise
    controller.abort()
    expect(await pending).toBeUndefined()
    expect(cancelled).toBe(true)
  })

  test("does not start already cancelled diagnostic work", async () => {
    let calls = 0
    const result = await collectCanaryFailureDiagnostics({
      origin,
      adminToken,
      signal: AbortSignal.abort(),
      async request() {
        calls++
        return Response.json({})
      },
    })
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  })
})
