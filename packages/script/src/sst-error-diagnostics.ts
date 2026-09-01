const maximumDiagnostics = 12
const maximumMessageLength = 600

export interface SstErrorDiagnostic {
  message: string
  resource?: string
}

export interface SstEventTrailEntry {
  event: string
  operation?: string
  resource?: string
}

export function inspectSstErrorDiagnostics(input: string, secretValues: readonly string[] = []) {
  const secrets = normalizedSecrets(secretValues)
  const diagnostics: SstErrorDiagnostic[] = []
  const seen = new Set<string>()

  for (const event of parseEvents(input)) {
    const diagnostic = event.diagnosticEvent
    if (!record(diagnostic) || diagnostic.severity !== "error" || typeof diagnostic.message !== "string") continue
    const message = sanitizeMessage(diagnostic.message, secrets)
    if (!message) continue
    const resource = typeof diagnostic.urn === "string" ? resourceLabel(diagnostic.urn) : undefined
    const key = `${resource ?? ""}\n${message}`
    if (seen.has(key)) continue
    seen.add(key)
    diagnostics.push({ message, ...(resource ? { resource } : {}) })
    if (diagnostics.length === maximumDiagnostics) break
  }

  return diagnostics
}

export function inspectSstCommandErrorDiagnostics(input: string, secretValues: readonly string[] = []) {
  const secrets = normalizedSecrets(secretValues)
  const diagnostics: SstErrorDiagnostic[] = []
  const seen = new Set<string>()

  for (const line of input.split(/\r?\n/)) {
    if (!/\b(?:error|failed|failure|forbidden|unauthorized|denied|exit status|exited with)\b/i.test(line)) continue
    const message = sanitizeMessage(line, secrets)
    if (!message || seen.has(message)) continue
    seen.add(message)
    diagnostics.push({ message })
    if (diagnostics.length === maximumDiagnostics) break
  }

  return diagnostics
}

export function inspectSstEventTrail(input: string) {
  const trail: SstEventTrailEntry[] = []
  for (const event of parseEvents(input)) {
    const entry = eventTrailEntry(event)
    if (!entry) continue
    trail.push(entry)
    if (trail.length > maximumDiagnostics) trail.shift()
  }
  return trail
}

function normalizedSecrets(secretValues: readonly string[]) {
  return [...new Set(secretValues.filter((value) => value.length >= 4))].sort(
    (left, right) => right.length - left.length,
  )
}

function parseEvents(input: string): Record<string, unknown>[] {
  const trimmed = input.trim()
  if (!trimmed) return []

  if (trimmed.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(trimmed)
      return Array.isArray(value) ? value.filter(record) : []
    } catch {
      return []
    }
  }

  const result: Record<string, unknown>[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      const value: unknown = JSON.parse(line)
      if (record(value)) result.push(value)
    } catch {
      // A partial event log must not hide the valid diagnostics that preceded it.
    }
  }
  return result
}

function eventTrailEntry(event: Record<string, unknown>): SstEventTrailEntry | undefined {
  for (const [key, label] of [
    ["resourcePreEvent", "resource-pre"],
    ["resOutputsEvent", "resource-output"],
    ["resOpFailedEvent", "resource-failed"],
  ] as const) {
    const payload = event[key]
    if (!record(payload)) continue
    const metadata = payload.metadata
    if (!record(metadata)) continue
    const operation = typeof metadata.op === "string" ? safeOperation(metadata.op) : undefined
    const resource = typeof metadata.urn === "string" ? resourceLabel(metadata.urn) : undefined
    return { event: label, ...(operation ? { operation } : {}), ...(resource ? { resource } : {}) }
  }
  if ("cancelEvent" in event) return { event: "cancel" }
  if ("summaryEvent" in event) return { event: "summary" }
  return undefined
}

function safeOperation(value: string) {
  const operation = value.replace(/[^A-Za-z0-9_.:/-]/g, "").slice(0, 64)
  return operation || undefined
}

function sanitizeMessage(input: string, secrets: readonly string[]) {
  let value = input.replace(/\x1b\[[0-9;]*m/g, "")
  for (const secret of secrets) value = value.split(secret).join("[redacted]")
  value = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:[0-9a-f]{24,}|[A-Za-z0-9_+./=-]{32,})\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
  return value.length > maximumMessageLength ? `${value.slice(0, maximumMessageLength - 3)}...` : value
}

function resourceLabel(urn: string) {
  const parts = urn.split("::")
  const type = parts.at(-2)?.split("$").at(-1)?.trim()
  const name = parts.at(-1)?.trim()
  if (!type || !name) return undefined
  const value = `${type} ${name}`.replace(/[^A-Za-z0-9_.:/ -]/g, "").replace(/\s+/g, " ").trim()
  return value ? value.slice(0, 180) : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
