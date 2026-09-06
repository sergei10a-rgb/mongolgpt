import { describe, expect, test } from "bun:test"
import { bootstrapRequest } from "./bootstrap-request"

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
