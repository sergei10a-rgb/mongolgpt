import { afterEach, expect, test } from "bun:test"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { checkpointControlHeader } from "@mongolgpt/runtime-auth/control"
import { startupDiagnosticEnv, parseStartupDiagnostic } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { reportStartupFailure } from "../../src/cli/startup-diagnostic"

const before = process.env[startupDiagnosticEnv]
afterEach(() => {
  if (before === undefined) delete process.env[startupDiagnosticEnv]
  else process.env[startupDiagnosticEnv] = before
})

test("reports only fixed safe fields to the authenticated fixed destination", async () => {
  process.env[startupDiagnosticEnv] = "true"
  const requests: Request[] = []
  await reportStartupFailure(
    new CloudStartup.StartupError({ message: "private-path-token", phase: "retire_root", code: "EXDEV" }),
    "a".repeat(64),
    async (request) => {
      requests.push(request)
      return new Response(null, { status: 204 })
    },
  )
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe("http://checkpoint.mongolgpt.internal/v1/startup-diagnostic")
  expect(requests[0].redirect).toBe("error")
  expect(requests[0].headers.get(checkpointControlHeader)).toBe("a".repeat(64))
  const body = await requests[0].json()
  expect(parseStartupDiagnostic(body)).toEqual(body)
  expect(body).toMatchObject({ phase: "retire_root", code: "EXDEV" })
  expect(JSON.stringify(body)).not.toContain("private")
})

test("does not request anything without exact opt-in and a valid control token", async () => {
  let calls = 0
  for (const flag of [undefined, "false", "1", "TRUE"]) {
    if (flag === undefined) delete process.env[startupDiagnosticEnv]
    else process.env[startupDiagnosticEnv] = flag
    await reportStartupFailure(new Error("private"), "a".repeat(64), async () => {
      calls++
      return new Response()
    })
  }
  process.env[startupDiagnosticEnv] = "true"
  await reportStartupFailure(new Error("private"), "invalid", async () => {
    calls++
    return new Response()
  })
  expect(calls).toBe(0)
})

test("a hanging diagnostic request cannot prevent fatal shutdown", async () => {
  process.env[startupDiagnosticEnv] = "true"
  let signal: AbortSignal | undefined
  const start = performance.now()
  await reportStartupFailure(new Error("private"), "a".repeat(64), async (request) => {
    signal = request.signal
    return new Promise<Response>(() => {})
  })
  expect(signal?.aborted).toBe(true)
  expect(performance.now() - start).toBeLessThan(3500)
})
