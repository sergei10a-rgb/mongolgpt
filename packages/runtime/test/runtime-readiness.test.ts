import { expect, test } from "bun:test"
import { runtimeReadiness } from "../src/runtime"

const headers = {
  "content-type": "application/json",
  "x-mongolgpt-runtime-history": "checkpoint-v1",
  "x-mongolgpt-runtime-isolation": "cgroup-v1",
  "x-mongolgpt-runtime-publication": "tool-pty-v1",
}
const body = JSON.stringify({ healthy: true, version: "current-test" })

test("readiness deadlines remain finite and cancel a stalled transport", async () => {
  let calls = 0
  const sandbox = {
    containerFetch(request: Request) {
      calls++
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    },
  }
  for (const timeout of [0, -1, 120_001, Number.NaN, Infinity, 1.5]) {
    await expect(runtimeReadiness(sandbox, "test", true, timeout)).rejects.toThrow("Invalid runtime readiness deadline")
  }
  expect(calls).toBe(0)
  expect(await runtimeReadiness(sandbox, "test", true, 20)).toEqual({ code: "timeout", status: null })
  expect(calls).toBe(1)
})

test("classifies the real admission guards without retaining private response data", async () => {
  const privateValue = "private-password-path-response-never-report"
  const scenarios = [
    { code: "ready", status: 200, response: () => new Response(body, { headers }) },
    ...[401, 503, 302].map((status) => ({
      code: "http_status",
      status,
      response: () => new Response(privateValue, { status, headers: { location: privateValue } }),
    })),
    ...(["history", "isolation", "publication"] as const).map((code) => ({
      code,
      status: 200,
      response: () => new Response(body, { headers: { ...headers, [`x-mongolgpt-runtime-${code}`]: privateValue } }),
    })),
    {
      code: "content_type",
      status: 200,
      response: () => new Response(privateValue, { headers: { ...headers, "content-type": "text/html" } }),
    },
    { code: "body_missing", status: 200, response: () => new Response(null, { headers }) },
    { code: "body_limit", status: 200, response: () => new Response("x".repeat(1025), { headers }) },
    { code: "body_json", status: 200, response: () => new Response(privateValue, { headers }) },
    ...[null, [], { healthy: false, version: "v1" }, { healthy: true, version: " " }].map((value) => ({
      code: "body_schema",
      status: 200,
      response: () => Response.json(value, { headers }),
    })),
    {
      code: "transport",
      status: null,
      response: () => {
        throw new Error(privateValue)
      },
    },
    {
      code: "body_read",
      status: 200,
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(privateValue))
            },
          }),
          { headers },
        ),
    },
  ]
  for (const scenario of scenarios) {
    const result = await runtimeReadiness(
      {
        containerFetch: async (request, port) => {
          expect(request.url).toBe("http://localhost/global/health")
          expect(request.headers.get("authorization")).toBe(`Basic ${btoa(`mongolgpt:${privateValue}`)}`)
          expect(request.redirect).toBe("manual")
          expect(port).toBe(4096)
          return scenario.response()
        },
      },
      privateValue,
      true,
    )
    expect<unknown>(result).toEqual({ code: scenario.code, status: scenario.status })
    expect(JSON.stringify(result)).not.toContain(privateValue)
  }
})

test("non-restored admission still does not require checkpoint receipts", async () => {
  expect(
    await runtimeReadiness({ containerFetch: async () => Response.json({ healthy: true, version: "v1" }) }, "test"),
  ).toEqual({ code: "ready", status: 200 })
})

test("reports timeout and cancels a stalled body without waiting for its cancellation", async () => {
  let cancelled = false
  const result = await runtimeReadiness(
    {
      containerFetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
              return new Promise<void>(() => {})
            },
          }),
          { headers },
        ),
    },
    "test",
    true,
  )
  expect(result).toEqual({ code: "timeout", status: 200 })
  expect(cancelled).toBe(true)
}, 10_000)
