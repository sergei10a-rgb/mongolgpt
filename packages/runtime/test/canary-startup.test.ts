import { describe, expect, test } from "bun:test"
import { checkpointControlHeader, deriveCheckpointControlToken } from "@mongolgpt/runtime-auth/control"
import { startupDiagnosticPath, type StartupDiagnostic } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { collectCanaryStartup } from "./fixtures/canary-startup"

const env = {
  STAGE: "dev",
  CANARY_RUN_ID: "mgpt-canary-123-1",
  CANARY_ADMIN_TOKEN: "a".repeat(64),
  MONGOLGPT_RUNTIME_SECRET: "b".repeat(64),
}
const scope = { accountID: "account_cloudflare_canary", workspaceID: "wrk_cloudflare_canary" }
const token = await deriveCheckpointControlToken(env.MONGOLGPT_RUNTIME_SECRET, scope)
const diagnostic: StartupDiagnostic = {
  phase: "retire_root",
  code: "EXDEV",
  overlay: true,
  workspaceMount: false,
  exitCode: null,
}
const url = `http://checkpoint.mongolgpt.internal${startupDiagnosticPath}`

function request(body: BodyInit = JSON.stringify(diagnostic), headers: HeadersInit = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", [checkpointControlHeader]: token, ...headers },
    body,
  })
}

describe("canary root startup collector", () => {
  test("stores the exact safe receipt only after the root token and scope are verified", async () => {
    const stored: StartupDiagnostic[] = []
    const response = await collectCanaryStartup(request(), env, { params: scope }, async (value) => {
      stored.push(value)
    })
    expect(response.status).toBe(204)
    expect(stored).toEqual([diagnostic])
    expect(await response.text()).toBe("")
  })

  test("rejects missing/wrong credentials, non-canary environments and cross-workspace contexts", async () => {
    let writes = 0
    for (const input of [
      { env: { ...env, STAGE: "production" }, scope, token },
      { env: { ...env, CANARY_RUN_ID: "user-workspace" }, scope, token },
      { env: { ...env, CANARY_ADMIN_TOKEN: "" }, scope, token },
      { env, scope: { ...scope, accountID: "another-account" }, token },
      { env, scope: { ...scope, workspaceID: "another-workspace" }, token },
      { env, scope, token: "" },
      { env, scope, token: "c".repeat(64) },
    ]) {
      const response = await collectCanaryStartup(
        request(undefined, { [checkpointControlHeader]: input.token }),
        input.env,
        { params: input.scope },
        async () => {
          writes++
        },
      )
      expect(response.status).toBe(403)
    }
    expect(writes).toBe(0)
  })

  test("rejects private fields, invalid JSON, invalid methods and URL aliases without storage", async () => {
    let writes = 0
    for (const req of [
      request(JSON.stringify({ ...diagnostic, token: "private-key" })),
      request(JSON.stringify({ ...diagnostic, code: "private-path" })),
      request(JSON.stringify({ ...diagnostic, phase: "native_runtime", exitCode: "private-exit" })),
      request(JSON.stringify({ ...diagnostic, phase: "native_runtime", exitCode: 256 })),
      request("not json"),
      request(new Uint8Array([255])),
      request(undefined, { "content-type": "text/plain" }),
      new Request(url, { method: "GET", headers: { [checkpointControlHeader]: token } }),
      new Request(`${url}?private=1`, request()),
      new Request(url.replace("http:", "https:"), request()),
    ]) {
      const response = await collectCanaryStartup(req, env, { params: scope }, async () => {
        writes++
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("")
    }
    expect(writes).toBe(0)
  })

  test("bounds chunked bodies and rejects oversized declared lengths before reading", async () => {
    let writes = 0
    for (const req of [
      request("x".repeat(513)),
      request(undefined, { "content-length": "513" }),
      request(undefined, { "content-length": "invalid" }),
    ]) {
      expect(
        (
          await collectCanaryStartup(req, env, { params: scope }, async () => {
            writes++
          })
        ).status,
      ).toBe(413)
    }
    expect(writes).toBe(0)
  })

  test("a stalled body is cancelled on the bounded deadline and never writes later", async () => {
    let cancelled = false
    let writes = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const before = performance.now()
    expect(
      (
        await collectCanaryStartup(request(body), env, { params: scope }, async () => {
          writes++
        })
      ).status,
    ).toBe(408)
    expect(performance.now() - before).toBeLessThan(3000)
    expect(cancelled).toBe(true)
    expect(writes).toBe(0)
  })
})
