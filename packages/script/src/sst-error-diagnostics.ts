const maximumDiagnostics = 12
const maximumMessageLength = 600

export interface SstErrorDiagnostic {
  message: string
  resource?: string
}

export function inspectSstErrorDiagnostics(input: string, secretValues: readonly string[] = []) {
  const secrets = [...new Set(secretValues.filter((value) => value.length >= 4))].sort(
    (left, right) => right.length - left.length,
  )
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
