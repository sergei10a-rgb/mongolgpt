import { describe, expect, test } from "bun:test"
import { reservePlanQuota } from "./plan-quota"

const now = new Date("2026-07-22T12:00:00.000Z")

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceID: "workspace-1",
    invoiceID: "inv_01J12345678901234567890123",
    userID: "user-1",
    now,
    limits: {
      weeklyCostLimit: 2,
      weeklyTokenLimit: 100_000,
      rollingCostLimit: 1,
      rollingWindow: 5,
    },
    reservation: { costInMicroCents: 250_000, tokens: 4_000 },
    ...overrides,
  }
}

describe("plan quota reservation", () => {
  test("reserves all three dimensions for a new user", async () => {
    const calls: Array<{ scope: string; command: Record<string, unknown> }> = []
    const quota = await reservePlanQuota(input(), async (scope, command) => {
      calls.push({ scope, command: command as Record<string, unknown> })
      return { allowed: true, values: {} }
    })

    expect(quota.allowed).toBe(true)
    expect(calls[0]?.scope).toBe("plan:workspace-1:inv_01J12345678901234567890123")
    expect(calls[0]?.command.type).toBe("reserve-many")
    const entries = calls[0]?.command.entries as Array<Record<string, unknown>>
    expect(entries.map((entry) => entry.counterKey)).toEqual([
      "user/user-1/weekly-cost",
      "user/user-1/weekly-tokens",
      "user/user-1/rolling-cost",
    ])
    expect(entries.map((entry) => entry.persistedUsage)).toEqual([0, 0, 0])
  })

  test("resets stale weekly and rolling persisted usage before reserving", async () => {
    let command: Record<string, unknown> | undefined
    await reservePlanQuota(
      input({
        existingPlanUsage: {
          fixedUsage: 999,
          timeFixedUpdated: new Date("2026-07-12T23:59:59.000Z"),
          weeklyTokens: 888,
          timeWeeklyTokensUpdated: new Date("2026-07-12T23:59:59.000Z"),
          rollingUsage: 777,
          timeRollingUpdated: new Date("2026-07-22T06:59:59.000Z"),
        },
      }),
      async (_scope, value) => {
        command = value as Record<string, unknown>
        return { allowed: true }
      },
    )

    expect((command?.entries as Array<Record<string, unknown>>).map((entry) => entry.persistedUsage)).toEqual([0, 0, 0])
  })

  test("maps a blocked counter to its correct reset window", async () => {
    const blocked = "user/user-1/rolling-cost"
    const result = await Promise.all([
      reservePlanQuota(input(), async () => ({ allowed: false, blockedKey: blocked })),
      reservePlanQuota(input(), async () => ({ allowed: false, blockedKey: blocked })),
    ])

    expect(result).toEqual([
      { allowed: false, retryAfter: 18_000, deactivated: false },
      { allowed: false, retryAfter: 18_000, deactivated: false },
    ])
  })

  test("settles with the exact three-dimensional command and is idempotent", async () => {
    const calls: Array<Record<string, unknown>> = []
    const quota = await reservePlanQuota(input(), async (_scope, command) => {
      calls.push(command as Record<string, unknown>)
      return { allowed: true }
    })
    if (!quota.allowed) throw new Error("expected reservation")

    await Promise.all([
      quota.reservation.settle({ costInMicroCents: 125_000, tokens: 2_000 }),
      quota.reservation.settle({ costInMicroCents: 1, tokens: 1 }),
    ])

    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ type: "settle-many", reservationID: calls[0]?.reservationID })
    expect(calls[1]?.entries).toEqual([
      { counterKey: "user/user-1/weekly-cost", actual: 125_000, expiresAt: Date.parse("2026-07-27T00:00:00.000Z") },
      { counterKey: "user/user-1/weekly-tokens", actual: 2_000, expiresAt: Date.parse("2026-07-27T00:00:00.000Z") },
      { counterKey: "user/user-1/rolling-cost", actual: 125_000, expiresAt: Date.parse("2026-07-22T17:00:00.000Z") },
    ])
  })

  test("uses reserved amounts when trusted actual usage is omitted", async () => {
    let settled: Record<string, unknown> | undefined
    const quota = await reservePlanQuota(input(), async (_scope, command) => {
      if (command.type === "settle-many") settled = command as Record<string, unknown>
      return { allowed: true }
    })
    if (!quota.allowed) throw new Error("expected reservation")
    await quota.reservation.settle()
    expect((settled?.entries as Array<Record<string, unknown>>).map((entry) => entry.actual)).toEqual([
      250_000, 4_000, 250_000,
    ])
  })

  test("fails closed for malformed responses and deactivated ledgers", async () => {
    await expect(reservePlanQuota(input(), async () => ({ values: {} }))).resolves.toEqual({
      allowed: false,
      retryAfter: 60,
      deactivated: false,
    })
    await expect(reservePlanQuota(input(), async () => ({ allowed: false, deactivated: true }))).resolves.toEqual({
      allowed: false,
      retryAfter: 0,
      deactivated: true,
    })
  })
})
