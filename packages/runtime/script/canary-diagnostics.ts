import { parseStartupDiagnostic, type StartupDiagnostic } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { parseRuntimeReadiness, type RuntimeReadiness } from "../src/runtime"

const containerStatuses = ["running", "healthy", "stopping", "stopped", "stopped_with_code"] as const
const processStatuses = ["starting", "running", "completed", "failed", "killed", "error"] as const
const stopReasons = ["exit", "runtime_signal"] as const
const signals = [
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
  "EACCES",
  "EPERM",
  "ENOENT",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOSPC",
  "EROFS",
  "EMFILE",
  "ENOMEM",
  "EIO",
] as const

type Signal = (typeof signals)[number]
export type CanaryDiagnostics = {
  bootCount: number | null
  startupFailure: { bootCount: number; diagnostic: StartupDiagnostic } | null
  readiness: RuntimeReadiness | null
  lastStop: { exitCode: number | null; reason: (typeof stopReasons)[number] | null } | null
  containerStatus: (typeof containerStatuses)[number] | null
  epoch: number | null
  checkpointPresent: boolean | null
  revisionPresent: boolean | null
  sequence: number | null
  process: {
    present: boolean | null
    status: (typeof processStatuses)[number] | null
    exitCode: number | null
    stdoutBytes: number | null
    stderrBytes: number | null
    signals: Signal[]
  }
  failure: "unavailable" | "timeout" | null
}

const maxCounter = 2_147_483_647
const maxLogBytes = 65_536
const inspectedLogBytes = 4096
const signalPatterns = signals.map((signal) => ({
  signal,
  pattern: new RegExp(`(?:^|[^A-Za-z0-9_])${signal}(?=$|[^A-Za-z0-9_])`),
}))

export function emptyCanaryDiagnostics(): CanaryDiagnostics {
  return {
    bootCount: null,
    startupFailure: null,
    readiness: null,
    lastStop: null,
    containerStatus: null,
    epoch: null,
    checkpointPresent: null,
    revisionPresent: null,
    sequence: null,
    process: { present: null, status: null, exitCode: null, stdoutBytes: null, stderrBytes: null, signals: [] },
    failure: null,
  }
}

// Reconstruct even the Worker response: reports must never trust extra fields.
export function sanitizeCanaryDiagnostics(input: unknown): CanaryDiagnostics | undefined {
  try {
    return parseDiagnostics(input)
  } catch {
    return undefined
  }
}

function parseDiagnostics(input: unknown): CanaryDiagnostics | undefined {
  const value = record(input)
  const process = record(value.process)
  const stop = record(value.lastStop)
  const empty = emptyCanaryDiagnostics()
  if (!Object.keys(empty).every((key) => Object.hasOwn(value, key))) return
  if (!Object.keys(empty.process).every((key) => Object.hasOwn(process, key))) return
  if (!Array.isArray(process.signals) || process.signals.length > 32) return
  if (process.signals.some((signal) => typeof signal !== "string" || signal.length > 64)) return
  const suppliedSignals = process.signals
  const exitCode = integer(stop.exitCode, 255)
  const reason = member(stop.reason, stopReasons)
  if (value.lastStop !== null && (exitCode !== stop.exitCode || reason !== stop.reason)) return
  const result: CanaryDiagnostics = {
    bootCount: integer(value.bootCount),
    startupFailure: parseCanaryStartupFailure(value.startupFailure) ?? null,
    readiness: parseCanaryReadiness(value.readiness) ?? null,
    lastStop: value.lastStop === null ? null : { exitCode, reason },
    containerStatus: member(value.containerStatus, containerStatuses),
    epoch: integer(value.epoch),
    checkpointPresent: boolean(value.checkpointPresent),
    revisionPresent: boolean(value.revisionPresent),
    sequence: integer(value.sequence),
    process: {
      present: boolean(process.present),
      status: member(process.status, processStatuses),
      exitCode: integer(process.exitCode, 255),
      stdoutBytes: integer(process.stdoutBytes, maxLogBytes),
      stderrBytes: integer(process.stderrBytes, maxLogBytes),
      signals: signals.filter((signal) => suppliedSignals.includes(signal)),
    },
    failure: value.failure === null ? null : value.failure === "timeout" ? "timeout" : "unavailable",
  }
  if (value.startupFailure !== null && result.startupFailure === null) return
  if (value.readiness !== null && result.readiness === null) return
  for (const key of [
    "bootCount",
    "containerStatus",
    "epoch",
    "checkpointPresent",
    "revisionPresent",
    "sequence",
    "failure",
  ] as const) {
    if (result[key] !== value[key]) return
  }
  for (const key of ["present", "status", "exitCode", "stdoutBytes", "stderrBytes"] as const) {
    if (result.process[key] !== process[key]) return
  }
  return result
}

export function summarizeCanaryLogs(stdout: unknown, stderr: unknown) {
  const out = inspectLog(stdout)
  const err = inspectLog(stderr)
  return {
    stdoutBytes: out.bytes,
    stderrBytes: err.bytes,
    signals: signalPatterns
      .filter(({ pattern }) => pattern.test(out.prefix) || pattern.test(err.prefix))
      .map(({ signal }) => signal),
  }
}

export function parseCanaryReadiness(input: unknown): RuntimeReadiness | null | undefined {
  return input === null ? null : parseRuntimeReadiness(input)
}

export function parseCanaryStartupFailure(input: unknown): CanaryDiagnostics["startupFailure"] | undefined {
  if (input === null) return null
  try {
    const value = record(input)
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "bootCount") || !Object.hasOwn(value, "diagnostic"))
      return
    const bootCount = integer(value.bootCount)
    const diagnostic = parseStartupDiagnostic(value.diagnostic)
    if (bootCount === null || !diagnostic) return
    return { bootCount, diagnostic }
  } catch {
    return undefined
  }
}

function inspectLog(input: unknown) {
  if (typeof input !== "string") return { bytes: null, prefix: "" }
  // encodeInto stops at the fixed destination capacity, even for huge SDK logs.
  const buffer = new Uint8Array(maxLogBytes)
  const { read, written } = new TextEncoder().encodeInto(input, buffer)
  return {
    bytes: read < input.length ? maxLogBytes : written,
    // A truncated identifier must not become an exact signal at the boundary.
    prefix:
      new TextDecoder().decode(buffer.subarray(0, Math.min(written, inspectedLogBytes))) +
      (written > inspectedLogBytes ? "_" : ""),
  }
}

function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function integer(input: unknown, maximum = maxCounter) {
  return typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= maximum ? input : null
}

function boolean(input: unknown) {
  return typeof input === "boolean" ? input : null
}

function member<const T extends readonly string[]>(input: unknown, allowed: T): T[number] | null {
  return typeof input === "string" ? (allowed.find((value) => value === input) ?? null) : null
}
