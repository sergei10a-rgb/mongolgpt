const allowedMetricKeys = new Set([
  "cf.continent",
  "cf.country",
  "cf.region",
  "cf.timezone",
  "duration",
  "request_length",
  "request_retry",
  "response_status",
  "status",
  "ip.prefix",
  "is_stream",
  "session",
  "request",
  "client",
  "user_agent",
  "model",
  "model.tier",
  "model.variant",
  "source",
  "provider",
  "provider.model",
  "provider.budget_usage",
  "model.budget_usage",
  "llm.error.code",
  "error.type",
  "workspace",
  "subscription",
  "response_length",
  "time_to_first_byte",
  "timestamp.first_byte",
  "timestamp.last_byte",
  "tokens.input",
  "tokens.output",
  "tokens.reasoning",
  "tokens.cache_read",
  "tokens.cache_write_5m",
  "tokens.cache_write_1h",
  "cost.input.microcents",
  "cost.output.microcents",
  "cost.cache_read.microcents",
  "cost.cache_write.microcents",
  "cost.total.microcents",
  "cost.input",
  "cost.output",
  "cost.cache_read",
  "cost.cache_write_5m",
  "cost.cache_write_1h",
  "cost.total",
])

export function sanitizeMetric(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]): [string, string | number | boolean][] => {
      if (!allowedMetricKeys.has(key)) return []
      if (typeof value === "boolean") return [[key, value]]
      if (typeof value === "number") return Number.isFinite(value) ? [[key, value]] : []
      if (typeof value !== "string") return []
      const limit = key === "user_agent" ? 256 : key === "error.type" ? 128 : 512
      return [[key, value.slice(0, limit)]]
    }),
  )
}

export function ipPrefix(ip: string | undefined) {
  const value = ip?.trim()
  if (!value) return undefined

  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped) return ipv4Prefix(mapped[1])
  if (value.includes(".")) return ipv4Prefix(value)
  if (!value.includes(":")) return undefined

  const split = value.split("::")
  if (split.length > 2) return undefined
  const head = split[0] ? split[0].split(":") : []
  const tail = split.length === 2 && split[1] ? split[1].split(":") : []
  const compressed = split.length === 2
  if ([...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined
  if (!compressed && head.length !== 8) return undefined

  const missing = compressed ? 8 - head.length - tail.length : 0
  if (compressed && missing < 1) return undefined
  const full = compressed ? [...head, ...Array.from({ length: missing }, () => "0"), ...tail] : head
  if (full.length !== 8) return undefined

  const prefix = full
    .slice(0, 4)
    .map((part) => parseInt(part, 16).toString(16))
    .join(":")
  return `${prefix}::/64`
}

function ipv4Prefix(ip: string) {
  const parts = ip.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  const octets = parts.map(Number)
  if (octets.some((part) => part < 0 || part > 255)) return undefined
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
}
