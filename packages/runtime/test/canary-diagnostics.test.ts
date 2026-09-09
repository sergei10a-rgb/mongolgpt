import { describe, expect, test } from "bun:test"
import { emptyCanaryDiagnostics, sanitizeCanaryDiagnostics, summarizeCanaryLogs } from "../script/canary-diagnostics"

const privateValue = "private-token-command-path-url-never-report"

function valid() {
  return {
    ...emptyCanaryDiagnostics(),
    bootCount: 2,
    lastStop: { exitCode: 143, reason: "runtime_signal" },
    containerStatus: "healthy",
    epoch: 5,
    checkpointPresent: true,
    revisionPresent: true,
    sequence: 7,
    process: {
      present: true,
      status: "failed",
      exitCode: 1,
      stdoutBytes: 0,
      stderrBytes: 128,
      signals: ["RuntimeStateError", "EACCES"],
    },
  }
}

describe("canary diagnostic report sanitization", () => {
  test("accepts only finite readiness codes and bounded HTTP status, never response content", () => {
    for (const readiness of [
      { code: "ready", status: 200 },
      { code: "http_status", status: 503 },
      { code: "timeout", status: null },
      { code: "publication", status: 200 },
    ] as const)
      expect(sanitizeCanaryDiagnostics({ ...valid(), readiness })?.readiness).toEqual(readiness)
    for (const readiness of [
      {},
      { code: privateValue, status: 200 },
      { code: "ready", status: null },
      { code: "ready", status: 503 },
      { code: "http_status", status: 99 },
      { code: "http_status", status: 600 },
      { code: "http_status", status: 200.5 },
      { code: "http_status", status: "503" },
      { code: "http_status", status: 503, body: privateValue },
      Object.defineProperty({}, "code", {
        enumerable: true,
        get() {
          throw new Error(privateValue)
        },
      }),
    ])
      expect(sanitizeCanaryDiagnostics({ ...valid(), readiness })).toBeUndefined()
  })

  test("accepts bounded startup evidence and rejects private or malformed nested receipts", () => {
    const startupFailure = {
      bootCount: 1,
      diagnostic: { phase: "retire_root", code: "EXDEV", overlay: true, workspaceMount: false, exitCode: null },
    }
    expect(sanitizeCanaryDiagnostics({ ...valid(), startupFailure })).toHaveProperty("startupFailure", startupFailure)
    for (const failure of [
      {},
      { ...startupFailure, bootCount: -1 },
      { ...startupFailure, bootCount: 2 ** 32 },
      { ...startupFailure, private: privateValue },
      { ...startupFailure, diagnostic: { ...startupFailure.diagnostic, token: privateValue } },
      { ...startupFailure, diagnostic: { ...startupFailure.diagnostic, phase: privateValue } },
    ])
      expect(sanitizeCanaryDiagnostics({ ...valid(), startupFailure: failure })).toBeUndefined()
  })

  test("reconstructs only the complete fixed envelope and never serializes private extra fields", () => {
    const expected = valid()
    const input = {
      ...expected,
      token: privateValue,
      metadata: { archive: privateValue, key: privateValue },
      lastStop: { ...expected.lastStop, message: privateValue },
      process: {
        ...expected.process,
        command: privateValue,
        stdout: privateValue,
        stderr: privateValue,
        stack: privateValue,
      },
      toJSON() {
        throw new Error(privateValue)
      },
    }
    const result = sanitizeCanaryDiagnostics(input)
    expect<unknown>(result).toEqual(expected)
    expect(result).not.toBe(input)
    expect(result?.process).not.toBe(input.process)
    expect(JSON.stringify(result)).not.toContain(privateValue)
    expect(JSON.stringify(result).length).toBeLessThan(4096)
  })

  test("rejects malformed, incomplete, inherited, and unknown-only envelopes without exception text", () => {
    for (const input of [
      undefined,
      null,
      [],
      "private",
      1,
      {},
      { token: privateValue },
      { failure: "timeout" },
      Object.create(valid()),
    ]) {
      expect(sanitizeCanaryDiagnostics(input)).toBeUndefined()
    }
    for (const key of Object.keys(valid())) {
      const input: Record<string, unknown> = valid()
      delete input[key]
      expect(sanitizeCanaryDiagnostics(input)).toBeUndefined()
    }
    for (const key of Object.keys(valid().process)) {
      const input = valid()
      delete (input.process as Record<string, unknown>)[key]
      expect(sanitizeCanaryDiagnostics(input)).toBeUndefined()
    }
    const getter = Object.defineProperty(valid(), "bootCount", {
      get() {
        throw new Error(privateValue)
      },
    })
    expect(sanitizeCanaryDiagnostics(getter)).toBeUndefined()
    expect(
      sanitizeCanaryDiagnostics(
        new Proxy(
          {},
          {
            get() {
              throw new Error(privateValue)
            },
          },
        ),
      ),
    ).toBeUndefined()
  })

  test("accepts nullable partial observations only inside a complete envelope", () => {
    for (const failure of [null, "unavailable", "timeout"] as const) {
      const input = { ...emptyCanaryDiagnostics(), failure }
      expect(sanitizeCanaryDiagnostics(input)).toEqual(input)
    }
  })

  test("requires exact enum and boolean values rather than copying private strings", () => {
    for (const patch of [
      { containerStatus: privateValue },
      { failure: privateValue },
      { checkpointPresent: "true" },
      { revisionPresent: 1 },
      { lastStop: { exitCode: 0, reason: privateValue } },
      { lastStop: [] },
      { process: [] },
      { process: { ...valid().process, status: privateValue } },
      { process: { ...valid().process, present: "false" } },
    ])
      expect(sanitizeCanaryDiagnostics({ ...valid(), ...patch })).toBeUndefined()
  })

  test("bounds counters, byte counts, and exit codes and rejects non-finite or fractional numbers", () => {
    for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, "1", []]) {
      for (const key of ["bootCount", "epoch", "sequence"]) {
        expect(sanitizeCanaryDiagnostics({ ...valid(), [key]: value })).toBeUndefined()
      }
      for (const key of ["exitCode", "stdoutBytes", "stderrBytes"]) {
        expect(sanitizeCanaryDiagnostics({ ...valid(), process: { ...valid().process, [key]: value } })).toBeUndefined()
      }
    }
    expect(sanitizeCanaryDiagnostics({ ...valid(), bootCount: 2_147_483_647 })?.bootCount).toBe(2_147_483_647)
    expect(sanitizeCanaryDiagnostics({ ...valid(), bootCount: 2_147_483_648 })).toBeUndefined()
    expect(
      sanitizeCanaryDiagnostics({ ...valid(), process: { ...valid().process, stderrBytes: 65_536 } })?.process
        .stderrBytes,
    ).toBe(65_536)
    expect(
      sanitizeCanaryDiagnostics({ ...valid(), process: { ...valid().process, stderrBytes: 65_537 } }),
    ).toBeUndefined()
    expect(sanitizeCanaryDiagnostics({ ...valid(), process: { ...valid().process, exitCode: 256 } })).toBeUndefined()
    expect(sanitizeCanaryDiagnostics({ ...valid(), lastStop: { exitCode: 256, reason: "exit" } })).toBeUndefined()
  })

  test("bounds and deduplicates signal arrays while dropping unrecognized strings", () => {
    const input = valid()
    input.process.signals = ["ENOENT", privateValue, "RuntimeStateError", "ENOENT", "ERR_DLOPEN_FAILED"]
    expect(sanitizeCanaryDiagnostics(input)?.process.signals).toEqual([
      "RuntimeStateError",
      "ERR_DLOPEN_FAILED",
      "ENOENT",
    ])
    for (const signals of [Array(33).fill("ENOENT"), [privateValue.repeat(1000)], [["ENOENT"]], {}, "ENOENT"]) {
      expect(sanitizeCanaryDiagnostics({ ...input, process: { ...input.process, signals } })).toBeUndefined()
    }
  })
})

describe("bounded canary log signals", () => {
  test("emits only literal allowlisted names, never messages, log lines, or arbitrary error classes", () => {
    const result = summarizeCanaryLogs(
      `RuntimeCheckpointClientError ${privateValue} CloudRuntimeStartupError RuntimeStateError WorkspaceIsolationError`,
      `RuntimeLockError CloudBaselineError RuntimeContainerControlError TypeError: ${privateValue} Error: ERR_DLOPEN_FAILED ENOENT OtherPrivateError`,
    )
    expect(result.signals).toEqual([
      "RuntimeCheckpointClientError",
      "CloudRuntimeStartupError",
      "RuntimeStateError",
      "WorkspaceIsolationError",
      "RuntimeLockError",
      "CloudBaselineError",
      "RuntimeContainerControlError",
      "TypeError",
      "Error",
      "ERR_DLOPEN_FAILED",
      "ENOENT",
    ])
    expect(JSON.stringify(result)).not.toContain(privateValue)
    expect(JSON.stringify(result)).not.toContain("OtherPrivateError")
    expect(
      summarizeCanaryLogs("prefixRuntimeStateError RuntimeStateErrorSuffix ENOENT_suffix", "TypeErrorPrivate").signals,
    ).toEqual([])
  })

  test("counts UTF-8 bytes with saturation and inspects no more than 4096 bytes per stream", () => {
    expect(summarizeCanaryLogs("\u00e9", "")).toEqual({ stdoutBytes: 2, stderrBytes: 0, signals: [] })
    expect(summarizeCanaryLogs("x".repeat(70_000), "y".repeat(70_000))).toEqual({
      stdoutBytes: 65_536,
      stderrBytes: 65_536,
      signals: [],
    })
    expect(summarizeCanaryLogs("\u00e9".repeat(2048) + " ENOENT", "x".repeat(4096) + " TypeError").signals).toEqual([])
    expect(summarizeCanaryLogs("ENOENT " + "x".repeat(10_000), "TypeError " + "y".repeat(10_000)).signals).toEqual([
      "TypeError",
      "ENOENT",
    ])
    expect(summarizeCanaryLogs(" ".repeat(4090) + "ENOENT_suffix", "").signals).toEqual([])
    expect(summarizeCanaryLogs({}, null)).toEqual({ stdoutBytes: null, stderrBytes: null, signals: [] })
  })
})
