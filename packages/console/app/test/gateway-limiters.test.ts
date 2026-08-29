import { beforeEach, describe, expect, mock, test } from "bun:test"
import * as coreDrizzle from "@mongolgpt/console-core/drizzle/index.js"

const quotaState = {
  result: { allowed: true, daily: 0, lifetime: 0 } as Record<string, unknown>,
  calls: [] as Array<{ scope: string; command: Record<string, unknown> }>,
}

const dbState = {
  rows: [] as Array<{ usage: number }>,
  inserted: [] as Array<{ ip: string; usage: number }>,
  duplicateUpdates: [] as unknown[],
}

const limits = {
  dailyRequests: 10,
  dailyRequestsFallback: 3,
  promoTokens: 100,
  checkHeaders: {
    "x-mongolgpt-gateway-proxy": "trusted",
  },
}
let freeLimitReads = 0

mock.module("../src/routes/gateway/util/quota-service", () => ({
  buildRateLimitKey: (kind: string, identifier: string, interval?: string) =>
    `ratelimit:${kind}:${identifier}${interval ? `:${interval}` : ""}`,
  hashIdentifier: async () => "hashed-secret",
  ledgerCommand: async (scope: string, command: Record<string, unknown>) => {
    quotaState.calls.push({ scope, command })
    return quotaState.result
  },
  claimResult: (value: unknown) => value,
}))

mock.module("../src/routes/gateway/util/logger", () => ({
  logger: {
    debug: () => undefined,
  },
}))

mock.module("@mongolgpt/console-core/subscription.js", () => ({
  Subscription: {
    getFreeLimits: () => {
      freeLimitReads++
      return limits
    },
  },
}))

mock.module("@mongolgpt/console-core/drizzle/index.js", () => ({
  ...coreDrizzle,
  Database: {
    use: (fn: (tx: any) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: async () => dbState.rows[0],
          }),
        }),
        insert: () => ({
          values: (value: { ip: string; usage: number }) => {
            dbState.inserted.push(value)
            return {
              onConflictDoUpdate: async ({ set }: { set: unknown }) => {
                dbState.duplicateUpdates.push(set)
              },
            }
          },
        }),
      }),
  },
  eq: (_left: unknown, right: unknown) => right,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}))

mock.module("@mongolgpt/console-core/schema/ip.sql.js", () => ({
  IpTable: {
    ip: "ip",
    usage: "usage",
  },
}))

const ipLimiterModule = await import("../src/routes/gateway/util/ipRateLimiter")
const keyLimiterModule = await import("../src/routes/gateway/util/keyRateLimiter")
const trialLimiterModule = await import("../src/routes/gateway/util/trialLimiter")

beforeEach(() => {
  quotaState.result = { allowed: true, daily: 0, lifetime: 0 }
  quotaState.calls = []
  dbState.rows = []
  dbState.inserted = []
  dbState.duplicateUpdates = []
  freeLimitReads = 0
})

describe("gateway limiters", () => {
  test("ip limiter falls back deterministically when trusted proxy headers are missing", async () => {
    quotaState.result = { allowed: false, daily: 3, lifetime: 0 }
    const request = new Request("https://example.com/gateway", {
      headers: {
        "accept-language": "en",
        "x-real-ip": "203.0.113.7",
      },
    })

    const limiter = await ipLimiterModule.createRateLimiter("gpt-5", 99, request)

    await expect(limiter.check()).rejects.toMatchObject({
      message: "Хүсэлтийн давтамжийн хязгаарт хүрлээ. Дараа дахин оролдоно уу.",
    })
    expect(quotaState.calls).toHaveLength(1)
    expect(quotaState.calls[0]?.scope).toContain("unknown")
    expect(quotaState.calls[0]?.scope).not.toContain("203.0.113.7")
    expect(quotaState.calls[0]?.command.lifetimeKey).toBeNull()
    expect(String(quotaState.calls[0]?.command.dailyKey)).not.toContain("gp")
  })

  test("ip limiter uses verified proxy headers for model-specific limits and Mongolian errors", async () => {
    quotaState.result = { allowed: false, daily: 2, lifetime: 0 }
    const request = new Request("https://example.com/gateway", {
      headers: {
        "accept-language": "mn",
        "cf-connecting-ip": "203.0.113.7",
        "x-mongolgpt-gateway-proxy": "trusted",
        "x-real-ip": "198.51.100.9",
      },
    })

    const limiter = await ipLimiterModule.createRateLimiter("gpt-5", 2, request)

    await expect(limiter.check()).rejects.toMatchObject({
      message: "Хүсэлтийн давтамжийн хязгаарт хүрлээ. Түр хүлээгээд дахин оролдоно уу.",
    })
    expect(String(quotaState.calls[0]?.command.dailyKey)).toContain("203.0.113.7")
    expect(String(quotaState.calls[0]?.command.dailyKey)).not.toContain("198.51.100.9")
    expect(String(quotaState.calls[0]?.command.dailyKey)).toContain("gp")
  })

  test("ip limiter requires exact trusted proxy header values", async () => {
    const request = new Request("https://example.com/gateway", {
      headers: {
        "accept-language": "en",
        "cf-connecting-ip": "203.0.113.7",
        "x-mongolgpt-gateway-proxy": "trusted edge",
      },
    })

    const limiter = await ipLimiterModule.createRateLimiter("gpt-5", 99, request)
    await limiter.check()

    expect(quotaState.calls[0]?.command.dailyLimit).toBe(limits.dailyRequestsFallback)
    expect(String(quotaState.calls[0]?.command.dailyKey)).not.toContain("gp")
  })

  test("client IP identity ignores spoofable headers and groups IPv6 privacy addresses by prefix", () => {
    const first = new Request("https://example.com/gateway", {
      headers: {
        "cf-connecting-ip": "2001:0DB8:1234:5678:1111:2222:3333:4444",
        "x-real-ip": "198.51.100.9",
        "x-forwarded-for": "192.0.2.8",
      },
    })
    const second = new Request("https://example.com/gateway", {
      headers: {
        "cf-connecting-ip": "2001:db8:1234:5678::abcd",
      },
    })

    expect(ipLimiterModule.clientIpFromRequest(first)).toBe("2001:db8:1234:5678")
    expect(ipLimiterModule.clientIpFromRequest(second)).toBe("2001:db8:1234:5678")
    expect(
      ipLimiterModule.clientIpFromRequest(
        new Request("https://example.com/gateway", { headers: { "x-real-ip": "203.0.113.8" } }),
      ),
    ).toBe("unknown")
    expect(
      ipLimiterModule.clientIpFromRequest(
        new Request("https://example.com/gateway", { headers: { "cf-connecting-ip": "not-an-ip" } }),
      ),
    ).toBe("unknown")
  })

  test("ip limiter tracks lifetime usage only for verified default traffic", async () => {
    quotaState.result = { allowed: true, daily: 1, lifetime: 1, isNew: true }
    const request = new Request("https://example.com/gateway", {
      headers: {
        "accept-language": "en",
        "cf-connecting-ip": "203.0.113.7",
        "x-mongolgpt-gateway-proxy": "trusted",
      },
    })

    const limiter = await ipLimiterModule.createRateLimiter("gpt-5", undefined, request)
    await limiter.check()
    await limiter.track()

    expect(quotaState.calls).toHaveLength(1)
    expect(String(quotaState.calls[0]?.command.dailyKey)).toContain("203.0.113.7")
    expect(String(quotaState.calls[0]?.command.lifetimeKey)).toContain("203.0.113.7")
  })

  test("injected free limits avoid an additional runtime configuration read", async () => {
    dbState.rows = [{ usage: 0 }]
    const request = new Request("https://example.com/gateway", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-mongolgpt-gateway-proxy": "trusted" },
    })
    const limiter = await ipLimiterModule.createRateLimiter("gpt-5", undefined, request, limits)
    await limiter.check()
    const trial = await trialLimiterModule.createTrialLimiter(["provider-a"], "203.0.113.9", limits)
    await trial?.check()
    expect(freeLimitReads).toBe(0)
  })

  test("key limiter returns clear Mongolian copy without exposing the key", async () => {
    quotaState.result = { allowed: false, value: 5 }
    const request = new Request("https://example.com/gateway", {
      headers: {
        "accept-language": "mn",
      },
    })

    const limiter = keyLimiterModule.createRateLimiter("gpt-5", 5, "sk-secret-token", request)
    await expect(limiter?.check()).rejects.toMatchObject({
      message: "API түлхүүрийн хүсэлтийн хязгаарт хүрлээ. Нэг минут хүлээгээд дахин оролдоно уу.",
    })
    expect(JSON.stringify(quotaState.calls)).not.toContain("sk-secret-token")
    expect(JSON.stringify(quotaState.calls)).toContain("hashed-secret")
  })

  test("trial limiter trims identifiers and records actual implementation usage totals", async () => {
    dbState.rows = [{ usage: 10 }]
    const limiter = await trialLimiterModule.createTrialLimiter(["provider-a"], " 203.0.113.9 ")

    await expect(limiter?.check()).resolves.toEqual(["provider-a"])
    await limiter?.track({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 3,
      cacheWrite5mTokens: 2,
      cacheWrite1hTokens: 1,
    })

    expect(dbState.inserted).toEqual([{ ip: "203.0.113.9", usage: 41 }])
    expect(JSON.stringify(dbState.inserted)).not.toContain(" 203.0.113.9 ")
  })
})
