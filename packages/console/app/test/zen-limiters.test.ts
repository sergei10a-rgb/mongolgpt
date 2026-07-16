import { beforeEach, describe, expect, mock, test } from "bun:test"

const redisState = {
  mgetValues: [] as Array<string | number | null>,
  mgetCalls: [] as string[][],
  pipelineIncr: [] as string[],
  pipelineExpire: [] as Array<{ key: string; ttl: number }>,
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

mock.module("../src/routes/zen/util/redis", () => ({
  buildRateLimitKey: (kind: string, identifier: string, interval?: string) =>
    `stage:ratelimit:${kind}:${identifier}${interval ? `:${interval}` : ""}`,
  getRedis: () => ({
    mget: async (keys: string[]) => {
      redisState.mgetCalls.push(keys)
      return redisState.mgetValues
    },
    pipeline: () => ({
      incr: (key: string) => {
        redisState.pipelineIncr.push(key)
        return undefined
      },
      expire: (key: string, ttl: number) => {
        redisState.pipelineExpire.push({ key, ttl })
        return undefined
      },
      exec: async () => [],
    }),
  }),
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
              onDuplicateKeyUpdate: async ({ set }: { set: unknown }) => {
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
  redisState.mgetValues = []
  redisState.mgetCalls = []
  redisState.pipelineIncr = []
  redisState.pipelineExpire = []
  dbState.rows = []
  dbState.inserted = []
  dbState.duplicateUpdates = []
})

describe("zen limiters", () => {
  test("ip limiter falls back deterministically when trusted proxy headers are missing", async () => {
    redisState.mgetValues = [3]
    const request = new Request("https://example.com/zen", {
      headers: {
        "accept-language": "en",
      },
    })

    const limiter = ipLimiterModule.createRateLimiter("gpt-5", 99, " 203.0.113.7 ", request)

    await expect(limiter.check()).rejects.toMatchObject({
      message: "Хүсэлтийн давтамжийн хязгаарт хүрлээ. Дараа дахин оролдоно уу.",
    })
    expect(redisState.mgetCalls).toHaveLength(1)
    expect(redisState.mgetCalls[0]).toHaveLength(1)
    expect(redisState.mgetCalls[0]?.[0]).toContain("203.0.113.7")
    expect(redisState.mgetCalls[0]?.[0]).not.toContain("gp")
  })

  test("ip limiter uses verified proxy headers for model-specific limits and Mongolian errors", async () => {
    redisState.mgetValues = [2]
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
    expect(redisState.mgetCalls[0]?.[0]).toContain("unknown")
    expect(redisState.mgetCalls[0]?.[0]).toContain("gp")
  })

  test("ip limiter tracks lifetime usage only for verified default traffic", async () => {
    redisState.mgetValues = [0, 0]
    const request = new Request("https://example.com/zen", {
      headers: {
        "accept-language": "en",
        "x-zen-proxy": "trusted edge",
      },
    })

    const limiter = ipLimiterModule.createRateLimiter("gpt-5", undefined, "203.0.113.7", request)
    await limiter.check()
    await limiter.track()

    expect(redisState.pipelineIncr).toHaveLength(2)
    expect(redisState.pipelineIncr[0]).toContain("203.0.113.7")
    expect(redisState.pipelineIncr[1]).toContain("203.0.113.7")
  })

  test("key limiter returns clear Mongolian copy without exposing the key", async () => {
    redisState.mgetValues = [5]
    const request = new Request("https://example.com/zen", {
      headers: {
        "accept-language": "mn",
      },
    })

    const limiter = keyLimiterModule.createRateLimiter("gpt-5", 5, "sk-secret-token", request)
    await expect(limiter?.check()).rejects.toMatchObject({
      message: "API түлхүүрийн хүсэлтийн хязгаарт хүрлээ. Нэг минут хүлээгээд дахин оролдоно уу.",
    })
    expect(redisState.mgetCalls[0]?.[0]).not.toContain("sk-secret-token")
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
