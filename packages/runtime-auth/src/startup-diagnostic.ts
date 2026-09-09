export const startupDiagnosticEnv = "MONGOLGPT_CANARY_STARTUP_DIAGNOSTICS"
export const startupDiagnosticPath = "/v1/startup-diagnostic"

export const startupDiagnosticPhases = Object.freeze([
  "supervisor",
  "native_runtime",
  "validate_root",
  "bootstrap_request",
  "bootstrap_decode",
  "sqlite_archive",
  "files_archive",
  "restore",
  "validate_publication",
  "retire_root",
  "publish_root",
  "rollback_root",
] as const)

export const startupDiagnosticCodes = Object.freeze([
  "unknown",
  "EXDEV",
  "EBUSY",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "ENOSPC",
  "EIO",
  "ENOMEM",
] as const)

export type StartupDiagnostic = {
  phase: (typeof startupDiagnosticPhases)[number]
  code: (typeof startupDiagnosticCodes)[number]
  overlay: boolean | null
  workspaceMount: boolean | null
  exitCode: number | null
}

export function parseStartupDiagnostic(input: unknown): StartupDiagnostic | undefined {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return
    const fields = ["phase", "code", "overlay", "workspaceMount", "exitCode"]
    const keys = Reflect.ownKeys(input)
    if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return
    const descriptors = Object.getOwnPropertyDescriptors(input)
    if (fields.some((field) => !("value" in descriptors[field]!))) return
    const { phase, code, overlay, workspaceMount, exitCode } = Object.fromEntries(
      fields.map((field) => [field, descriptors[field]!.value]),
    )
    const safePhase = startupDiagnosticPhases.find((value) => value === phase)
    const safeCode = startupDiagnosticCodes.find((value) => value === code)
    if (!safePhase || !safeCode) return
    if (overlay !== null && typeof overlay !== "boolean") return
    if (workspaceMount !== null && typeof workspaceMount !== "boolean") return
    if (
      exitCode !== null &&
      (safePhase !== "native_runtime" || !Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255)
    )
      return
    return { phase: safePhase, code: safeCode, overlay, workspaceMount, exitCode }
  } catch {
    return undefined
  }
}
