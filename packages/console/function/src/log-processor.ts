import { Resource } from "@mongolgpt/console-resource"
import type { TraceItem } from "@cloudflare/workers-types"

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

export default {
  async tail(events: TraceItem[]) {
    for (const event of events) {
      if (!event.event) continue
      if (!("request" in event.event)) continue
      if (event.event.request.method !== "POST") continue

      const url = new URL(event.event.request.url)
      if (
        url.pathname !== "/zen/v1/chat/completions" &&
        url.pathname !== "/zen/v1/messages" &&
        url.pathname !== "/zen/v1/responses" &&
        !url.pathname.startsWith("/zen/v1/models/") &&
        url.pathname !== "/zen/go/v1/chat/completions" &&
        url.pathname !== "/zen/go/v1/messages" &&
        url.pathname !== "/zen/go/v1/responses" &&
        !url.pathname.startsWith("/zen/go/v1/models/")
      )
        continue

      let data = sanitizeMetric({
        "cf.continent": event.event.request.cf?.continent,
        "cf.country": event.event.request.cf?.country,
        "cf.region": event.event.request.cf?.region,
        "cf.timezone": event.event.request.cf?.timezone,
        duration: event.wallTime,
        request_length: parseInt(event.event.request.headers["content-length"] ?? "0"),
        status: event.event.response?.status ?? 0,
        "ip.prefix": ipPrefix(event.event.request.headers["x-real-ip"]),
      })
      const time = new Date(event.eventTimestamp ?? Date.now()).toISOString()
      const telemetryEvents = [
        ...event.logs.flatMap((log) =>
          log.message.flatMap((message: string) => {
            if (!message.startsWith("_metric:")) return []
            const metric = parseMetric(message)
            if (!metric) return []
            data = { ...data, ...metric }
            if ("llm.error.code" in metric) {
              return [{ time, data: { ...data, event_type: "llm.error" } }]
            }
            return []
          }),
        ),
        { time, data: { ...data, event_type: "completions" } },
      ]
      const honeycomb = await fetch("https://api.honeycomb.io/1/batch/zen", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Honeycomb-Team": Resource.HONEYCOMB_API_KEY.value,
        },
        body: JSON.stringify(telemetryEvents),
      })
      if (!honeycomb.ok) console.error("Honeycomb ingest failed", honeycomb.status, honeycomb.statusText)
    }
  },
}

function parseMetric(message: string) {
  try {
    const metric = sanitizeMetric(JSON.parse(message.slice(8)))
    return Object.keys(metric).length ? metric : undefined
  } catch {
    return undefined
  }
}

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
  const full = compressed ? [...head, ...new Array(missing).fill("0"), ...tail] : head
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
