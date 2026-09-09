import { describe, expect, test } from "bun:test"
import { bootstrapRequest, bootstrapTimeoutMs } from "./bootstrap-request"
import { ServerScope } from "@/utils/server-scope"

describe("bootstrap deadline by server scope", () => {
  for (const scope of [
    "local",
    "sidecar",
    "wsl:Ubuntu",
    "invalid",
    "file:///workspace",
    "http://localhost:4096",
    "http://127.0.0.1:4096",
    "http://127.2.3.4",
    "http://[::1]:4096",
    "http://[::]",
    "http://0.0.0.0",
    "https://test.localhost",
  ]) {
    test(`retains the thirty-second budget for ${scope}`, () => {
      expect(bootstrapTimeoutMs(scope as ServerScope)).toBe(30_000)
    })
  }
  for (const scope of [
    "https://runtime.dev.mgpt.mn",
    "https://runtime.mgpt.mn",
    "http://192.168.1.20:4096",
    "https://remote.example/api",
  ]) {
    test(`permits a bounded cold start for ${scope}`, () => {
      expect(bootstrapTimeoutMs(scope as ServerScope)).toBe(120_000)
    })
  }
})

describe("bootstrapRequest", () => {
  test("returns the actual response and leaves successful requests un-aborted", async () => {
    const parent = new AbortController()
    let forwarded: AbortSignal | undefined
    const result = await bootstrapRequest(
      async (signal) => {
        forwarded = signal
        return { ready: true }
      },
      parent.signal,
      10,
    )
    expect(result).toEqual({ ready: true })
    await Bun.sleep(20)
    expect(forwarded?.aborted).toBe(false)
    parent.abort()
    expect(forwarded?.aborted).toBe(false)
  })

  test("bounds an unresponsive request even when its fetch ignores abort", async () => {
    let forwarded: AbortSignal | undefined
    const request = bootstrapRequest(
      (signal) => {
        forwarded = signal
        return new Promise(() => {})
      },
      new AbortController().signal,
      5,
    )
    await expect(request).rejects.toMatchObject({ name: "TimeoutError" })
    expect(forwarded?.aborted).toBe(true)
  })

  test("propagates query cancellation without waiting for the deadline", async () => {
    const parent = new AbortController()
    const request = bootstrapRequest(() => new Promise(() => {}), parent.signal, 1000)
    parent.abort(new DOMException("Query cancelled", "AbortError"))
    await expect(request).rejects.toMatchObject({ name: "AbortError" })
  })

  test("does not start an already-cancelled query", async () => {
    const parent = new AbortController()
    parent.abort()
    let calls = 0
    await expect(bootstrapRequest(async () => ++calls, parent.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(0)
  })

  test("preserves request failures instead of returning an empty catalog", async () => {
    const failure = new Error("unavailable")
    await expect(bootstrapRequest(() => Promise.reject(failure), new AbortController().signal)).rejects.toBe(failure)
  })
})
