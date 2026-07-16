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
      const lakeIngest = getLakeIngest()
      const [honeycomb, lake] = await Promise.all([
        fetch("https://api.honeycomb.io/1/batch/zen", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Honeycomb-Team": Resource.HONEYCOMB_API_KEY.value,
          },
          body: JSON.stringify(telemetryEvents),
        }),
        ...(lakeIngest
          ? [
              fetch(lakeIngest.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${lakeIngest.secret}`,
                },
                body: JSON.stringify({
                  events: telemetryEvents.map((event) => toLakeEvent(event.time, event.data)),
                }),
              }),
            ]
          : []),
      ])
      if (!honeycomb.ok) console.error("Honeycomb ingest failed", honeycomb.status, honeycomb.statusText)
      if (lake && !lake.ok) console.error("Lake ingest failed", lake.status, lake.statusText)
    }
  },
}

function getLakeIngest(): { url: string; secret: string } | undefined {
  try {
    return Resource.LakeIngest
  } catch {
    return undefined
  }
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

export function toLakeEvent(time: string, input: Record<string, unknown>) {
  const data = sanitizeMetric(input)
  const eventType = string(input, "event_type")
  return {
    _datalake_key: "inference.event",
    event_timestamp: time,
    event_date: time.slice(0, 10),
    event_type: eventType === "llm.error" ? eventType : "completions",
    dataset: "zen",
    cf_continent: string(data, "cf.continent"),
    cf_country: string(data, "cf.country"),
    cf_region: string(data, "cf.region"),
    cf_timezone: string(data, "cf.timezone"),
    duration: number(data, "duration"),
    request_length: integer(data, "request_length"),
    status: integer(data, "response_status") ?? integer(data, "status"),
    ip_prefix: string(data, "ip.prefix"),
    is_stream: boolean(data, "is_stream"),
    session: string(data, "session"),
    request: string(data, "request"),
    client: string(data, "client"),
    user_agent: string(data, "user_agent"),
    model: string(data, "model"),
    model_tier: string(data, "model.tier"),
    model_variant: string(data, "model.variant"),
    source: string(data, "source"),
    provider: string(data, "provider"),
    provider_model: string(data, "provider.model"),
    llm_error_code: integer(data, "llm.error.code"),
    error_type: string(data, "error.type"),
    workspace: string(data, "workspace"),
    subscription: string(data, "subscription"),
    response_length: integer(data, "response_length"),
    time_to_first_byte: integer(data, "time_to_first_byte"),
    timestamp_first_byte: integer(data, "timestamp.first_byte"),
    timestamp_last_byte: integer(data, "timestamp.last_byte"),
    tokens_input: integer(data, "tokens.input"),
    tokens_output: integer(data, "tokens.output"),
    tokens_reasoning: integer(data, "tokens.reasoning"),
    tokens_cache_read: integer(data, "tokens.cache_read"),
    tokens_cache_write_5m: integer(data, "tokens.cache_write_5m"),
    tokens_cache_write_1h: integer(data, "tokens.cache_write_1h"),
    cost_input_microcents: integer(data, "cost.input.microcents"),
    cost_output_microcents: integer(data, "cost.output.microcents"),
    cost_cache_read_microcents: integer(data, "cost.cache_read.microcents"),
    cost_cache_write_microcents: integer(data, "cost.cache_write.microcents"),
    cost_total_microcents: integer(data, "cost.total.microcents"),
  }
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

function string(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function boolean(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true" ? true : value === "false" ? false : undefined
  return undefined
}

function integer(data: Record<string, unknown>, key: string) {
  const value = number(data, key)
  if (value === undefined) return undefined
  return Math.round(value)
}

function number(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
