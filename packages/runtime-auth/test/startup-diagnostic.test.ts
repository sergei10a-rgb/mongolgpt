import { describe, expect, test } from "bun:test"
import {
  parseStartupDiagnostic,
  startupDiagnosticCodes,
  startupDiagnosticEnv,
  startupDiagnosticPath,
  startupDiagnosticPhases,
} from "../src/startup-diagnostic"

const valid = { phase: "retire_root", code: "EXDEV", overlay: true, workspaceMount: false, exitCode: null } as const

describe("startup diagnostic contract", () => {
  test("exports the fixed transport and accepts every bounded combination", () => {
    expect(startupDiagnosticEnv).toBe("MONGOLGPT_CANARY_STARTUP_DIAGNOSTICS")
    expect(startupDiagnosticPath).toBe("/v1/startup-diagnostic")
    for (const phase of startupDiagnosticPhases)
      for (const code of startupDiagnosticCodes)
        for (const overlay of [true, false, null])
          for (const workspaceMount of [true, false, null]) {
            const input = { phase, code, overlay, workspaceMount, exitCode: null }
            const parsed = parseStartupDiagnostic(input)
            expect(parsed).toEqual(input)
            expect(parsed).not.toBe(input)
          }
    expect(Object.isFrozen(startupDiagnosticPhases)).toBe(true)
    expect(Object.isFrozen(startupDiagnosticCodes)).toBe(true)
  })

  test("bounds native failure status and rejects status for pre-child phases", () => {
    for (const exitCode of [null, 1, 17, 127, 255])
      expect(parseStartupDiagnostic({ ...valid, phase: "native_runtime", exitCode })).toEqual({
        ...valid,
        phase: "native_runtime",
        exitCode,
      })
    for (const exitCode of [undefined, 0, -1, 256, 1.5, NaN, Infinity, "17", {}, true])
      expect(parseStartupDiagnostic({ ...valid, phase: "native_runtime", exitCode })).toBeUndefined()
    for (const phase of startupDiagnosticPhases.filter((value) => value !== "native_runtime"))
      expect(parseStartupDiagnostic({ ...valid, phase, exitCode: 17 })).toBeUndefined()
  })

  test("rejects missing fields, unknown values, arrays and private extras", () => {
    for (const value of [null, undefined, true, 0, "private-token", [], [valid], new Date()])
      expect(parseStartupDiagnostic(value)).toBeUndefined()
    for (const field of Object.keys(valid)) {
      const missing = { ...valid } as Record<string, unknown>
      delete missing[field]
      expect(parseStartupDiagnostic(missing)).toBeUndefined()
      for (const value of [undefined, {}, [], 42, "private-user@example.test"])
        expect(parseStartupDiagnostic({ ...valid, [field]: value })).toBeUndefined()
    }
    for (const field of ["token", "message", "stack", "path", "email", "accountID", "url"])
      expect(parseStartupDiagnostic({ ...valid, [field]: "private-value" })).toBeUndefined()
    expect(parseStartupDiagnostic({ ...valid, code: "ETIMEDOUT" })).toBeUndefined()
    expect(parseStartupDiagnostic({ ...valid, phase: "retire_root\nprivate" })).toBeUndefined()
    expect(parseStartupDiagnostic({ ...valid, [Symbol("private")]: "private" })).toBeUndefined()
  })

  test("does not invoke accessors or throw private exceptions", () => {
    let reads = 0
    const accessor = Object.defineProperty({ ...valid }, "phase", {
      get() {
        reads++
        throw new Error("private")
      },
    })
    expect(parseStartupDiagnostic(accessor)).toBeUndefined()
    expect(reads).toBe(0)
    expect(parseStartupDiagnostic(Object.defineProperty({ ...valid }, "private", { value: "secret" }))).toBeUndefined()
    const proxy = Proxy.revocable({ ...valid }, {})
    proxy.revoke()
    expect(parseStartupDiagnostic(proxy.proxy)).toBeUndefined()
    expect(parseStartupDiagnostic(Object.assign(Object.create(null), valid))).toEqual(valid)
  })
})
