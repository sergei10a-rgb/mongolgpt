import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { verifyDevPaymentHealth } from "../src/payment-service-live-check"

const legacy = {
  status: "disabled",
  service: "payments",
  environment: "disabled",
  providers: { qpay: false, bonum: false },
  catalog: false,
  checkout: false,
  cancellation: false,
  refund: false,
}
const capability = { enabled: false, checkout: false, cancellation: false, refund: false }
const current = { ...legacy, providers: { qpay: capability, bonum: capability } }
const failure = "Disabled dev payment health verification failed"
const responseFetcher = (body: unknown) => async () => Response.json(body)

test("requires the current capability contract after deployment, permits exact legacy disabled only before", async () => {
  expect(await verifyDevPaymentHealth("before", { fetch: responseFetcher(legacy) })).toEqual({
    stage: "dev",
    service: "payments",
    phase: "before",
    environment: "disabled",
    contract: "legacy",
  })
  await expect(verifyDevPaymentHealth("after", { fetch: responseFetcher(legacy) })).rejects.toThrow(failure)
  for (const phase of ["before", "after"] as const)
    expect(await verifyDevPaymentHealth(phase, { fetch: responseFetcher(current) })).toEqual({
      stage: "dev",
      service: "payments",
      phase,
      environment: "disabled",
      contract: "current",
    })
})

test("refuses any enabled capability, catalog, wrong environment, status, service, and unknown fields", async () => {
  const invalid = [
    null,
    {},
    { ...current, status: "ok" },
    { ...current, status: "degraded" },
    { ...current, environment: "production" },
    { ...current, environment: "sandbox" },
    { ...current, service: "console" },
    { ...current, secret: "private-health-token" },
    ...["catalog", "checkout", "cancellation", "refund"].map((key) => ({ ...current, [key]: true })),
    ...["qpay", "bonum"].flatMap((provider) =>
      Object.keys(capability).map((key) => ({
        ...current,
        providers: { ...current.providers, [provider]: { ...capability, [key]: true } },
      })),
    ),
    { ...legacy, providers: { qpay: true, bonum: false } },
    { ...legacy, secret: "private-health-token" },
  ]
  for (const phase of ["before", "after"] as const)
    for (const value of invalid)
      await expect(verifyDevPaymentHealth(phase, { fetch: responseFetcher(value) })).rejects.toThrow(failure)
})

test("uses only the fixed dev GET endpoint without credentials or redirects against a real local server", async () => {
  const received: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      received.push(request.method)
      expect(new URL(request.url).pathname).toBe("/health")
      expect(request.headers.get("authorization")).toBeNull()
      expect(request.headers.get("cookie")).toBeNull()
      return Response.json(current)
    },
  })
  try {
    const result = await verifyDevPaymentHealth("after", {
      fetch: async (url, options) => {
        expect(url).toBe("https://pay.dev.mgpt.mn/health")
        expect(options?.method).toBe("GET")
        expect(options?.redirect).toBe("error")
        expect(options?.cache).toBe("no-store")
        expect(options?.headers).toEqual({ Accept: "application/json" })
        return fetch(new URL("/health", server.url), options)
      },
    })
    expect(result.contract).toBe("current")
    expect(received).toEqual(["GET"])
  } finally {
    await server.stop(true)
  }
})

test("rejects HTML, redirects, errors, malformed JSON, invalid encoding and oversized bodies privately", async () => {
  const responses = [
    () => new Response("private-body", { headers: { "Content-Type": "text/html" } }),
    () => Response.json(current, { status: 503 }),
    () => Response.redirect("https://example.invalid/private-token"),
    () => new Response("private-not-json", { headers: { "Content-Type": "application/json" } }),
    () => new Response(" ".repeat(16_385), { headers: { "Content-Type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }),
    () => new Response(null, { headers: { "Content-Type": "application/json" } }),
  ]
  for (const response of responses) {
    const result = verifyDevPaymentHealth("after", { fetch: async () => response() })
    await expect(result).rejects.toThrow(failure)
    await result.catch((error: Error) => expect(error.message).not.toMatch(/private-|example\.invalid/))
  }
})

test("bounds stalled body and cancellation without leaking fetch errors", async () => {
  let cancelled = false
  let signal: AbortSignal | undefined
  const stalled = verifyDevPaymentHealth("after", {
    timeoutMs: 20,
    fetch: async (_, options) => {
      signal = options?.signal ?? undefined
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    },
  })
  await expect(stalled).rejects.toThrow(failure)
  expect(cancelled).toBe(true)
  expect(signal?.aborted).toBe(true)
  await expect(
    verifyDevPaymentHealth("before", {
      fetch: async () => {
        throw new Error("private-network-credential")
      },
    }),
  ).rejects.toThrow(failure)
})

test("invalid checker arguments fail before any request and CLI never prints them", async () => {
  let calls = 0
  const fetcher = async () => {
    calls++
    return Response.json(current)
  }
  for (const timeoutMs of [0, -1, 10_001, Infinity, 1.1])
    await expect(verifyDevPaymentHealth("before", { timeoutMs, fetch: fetcher })).rejects.toThrow(failure)
  await expect(verifyDevPaymentHealth("private-phase" as "before", { fetch: fetcher })).rejects.toThrow(failure)
  expect(calls).toBe(0)
  for (const args of [[], ["private-phase"], ["before", "private-extra"]]) {
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../../script/check-dev-payment-service.ts"), ...args],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited).toBe(1)
    expect(output).toBe("")
    expect(error).not.toMatch(/private-phase|private-extra/)
    expect(error).toContain("response bodies and private details were not printed")
  }
})
