import { beforeEach, describe, expect, mock, test } from "bun:test"

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
    "x-zen-proxy": "trusted",
  },
}

mock.module("../src/routes/zen/util/quota-service", () => ({
  buildRateLimitKey: (kind: string, identifier: string, interval?: string) =>
    `ratelimit:${kind}:${identifier}${interval ? `:${interval}` : ""}`,
  hashIdentifier: async () => "hashed-secret",
  ledgerCommand: async (scope: string, command: Record<string, unknown>) => {
    quotaState.calls.push({ scope, command })
    return quotaState.result
  },
  claimResult: (value: unknown) => value,
}))

mock.module("../src/routes/zen/util/logger", () => ({
  logger: {
    debug: () => undefined,
  },
}))

mock.module("@mongolgpt/console-core/subscription.js", () => ({
  Subscription: {
    getFreeLimits: () => limits,
  },
}))

mock.module("@mongolgpt/console-core/drizzle/index.js", () => ({
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

const ipLimiterModule = await import("../src/routes/zen/util/ipRateLimiter")
const keyLimiterModule = await import("../src/routes/zen/util/keyRateLimiter")
const trialLimiterModule = await import("../src/routes/zen/util/trialLimiter")

beforeEach(() => {
  quotaState.result = { allowed: true, daily: 0, lifetime: 0 }
  quotaState.calls = []
  dbState.rows = []
  dbState.inserted = []
  dbState.duplicateUpdates = []
})

describe("zen limiters", () => {
  test("ip limiter falls back deterministically when trusted proxy headers are missing", async () => {
    quotaState.result = { allowed: false, daily: 3, lifetime: 0 }
    const request = new Request("https://example.com/zen", {
      headers: {
        "accept-language": "en",
      },
    })

    const limiter = ipLimiterModule.createRateLimiter("gpt-5", 99, " 203.0.113.7 ", request)

    await expect(limiter.check()).rejects.toMatchObject({
      message: "Хүсэлтийн давтамжийн хязгаарт хүрлээ. Дараа дахин оролдоно уу.",
    })
    expect(quotaState.calls).toHaveLength(1)
    expect(quotaState.calls[0]?.scope).toContain("203.0.113.7")
    expect(quotaState.calls[0]?.command.lifetimeKey).toBeNull()
    expect(String(quotaState.calls[0]?.command.dailyKey)).not.toContain("gp")
  })

  test("ip limiter uses verified proxy headers for model-specific limits and Mongolian errors", async () => {
    quotaState.result = { allowed: false, daily: 2, lifetime: 0 }
    const request = new Request("https://example.com/zen", {
      headers: {
        "accept-language": "mn",
        "x-zen-proxy": "trusted edge",
      },
    })

    const limiter = ipLimiterModule.createRateLimiter("gpt-5", 2, "", request)

    await expect(limiter.check()).rejects.toMatchObject({
      message: "Хүсэлтийн давтамжийн хязгаарт хүрлээ. Түр хүлээгээд дахин оролдоно уу.",
    })
    expect(String(quotaState.calls[0]?.command.dailyKey)).toContain("unknown")
    expect(String(quotaState.calls[0]?.command.dailyKey)).toContain("gp")
  })

  test("ip limiter tracks lifetime usage only for verified default traffic", async () => {
    quotaState.result = { allowed: true, daily: 1, lifetime: 1, isNew: true }
    const request = new Request("https://example.com/zen", {
      headers: {
        "accept-language": "en",
        "x-zen-proxy": "trusted edge",
      },
    })

    const limiter = ipLimiterModule.createRateLimiter("gpt-5", undefined, "203.0.113.7", request)
    await limiter.check()
    await limiter.track()

    expect(quotaState.calls).toHaveLength(1)
    expect(String(quotaState.calls[0]?.command.dailyKey)).toContain("203.0.113.7")
    expect(String(quotaState.calls[0]?.command.lifetimeKey)).toContain("203.0.113.7")
  })

  test("key limiter returns clear Mongolian copy without exposing the key", async () => {
    quotaState.result = { allowed: false, value: 5 }
    const request = new Request("https://example.com/zen", {
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
    const limiter = trialLimiterModule.createTrialLimiter(["provider-a"], " 203.0.113.9 ")

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
