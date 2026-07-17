import { describe, expect, test } from "bun:test"
import { ipPrefix, sanitizeMetric } from "../../function/src/log-processor"

describe("log processor telemetry privacy", () => {
  test("keeps allowlisted metadata and removes secrets or content", () => {
    const metric = sanitizeMetric({
      workspace: "wrk_test",
      subscription: "pro",
      "tokens.input": 42,
      user_agent: "a".repeat(400),
      api_key: "secret-key",
      user_id: "usr_test",
      ip: "203.0.113.45",
      "cf.city": "Ulaanbaatar",
      "cf.latitude": "47.9",
      "cf.longitude": "106.9",
      "error.message": "provider response body",
      request_body: { prompt: "private prompt" },
    })

    expect(metric.workspace).toBe("wrk_test")
    expect(metric.subscription).toBe("pro")
    expect(metric["tokens.input"]).toBe(42)
    expect(metric.user_agent).toBe("a".repeat(256))
    expect(metric).not.toHaveProperty("api_key")
    expect(metric).not.toHaveProperty("user_id")
    expect(metric).not.toHaveProperty("ip")
    expect(metric).not.toHaveProperty("cf.city")
    expect(metric).not.toHaveProperty("cf.latitude")
    expect(metric).not.toHaveProperty("cf.longitude")
    expect(metric).not.toHaveProperty("error.message")
    expect(metric).not.toHaveProperty("request_body")
  })

  test("coarsens valid IP addresses and rejects malformed values", () => {
    expect(ipPrefix("203.0.113.45")).toBe("203.0.113.0/24")
    expect(ipPrefix("::ffff:203.0.113.45")).toBe("203.0.113.0/24")
    expect(ipPrefix("2001:0db8:abcd:1234:5678:90ab:cdef:1234")).toBe("2001:db8:abcd:1234::/64")
    expect(ipPrefix("2001:db8:abcd:1234::1")).toBe("2001:db8:abcd:1234::/64")
    expect(ipPrefix("999.0.0.1")).toBeUndefined()
    expect(ipPrefix("not-an-ip")).toBeUndefined()
  })
})
