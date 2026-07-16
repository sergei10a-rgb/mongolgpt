import { describe, expect, test } from "bun:test"
import { freeAutoReservationUpperBound, reserveFreeAutoQuota } from "./free-auto-quota"

describe("Free Auto weekly quota reservation", () => {
  test("reserves the configured per-request upper bound", () => {
    expect(freeAutoReservationUpperBound(32_000, 100_000)).toBe(32_000)
  })

  test("never reserves more than the weekly limit", () => {
    expect(freeAutoReservationUpperBound(1_000_000, 100_000)).toBe(100_000)
  })

  test("uses reservation IDs and keeps the ledger alive until the weekly reset", async () => {
    const calls: Array<{ keys: string[]; args: unknown[] }> = []
    const redis = {
      async eval(_script: string, keys: string[], args: unknown[]) {
        calls.push({ keys, args })
        return calls.length === 1 ? [1, 5_000] : 4_500
      },
    }
    const quota = await reserveFreeAutoQuota(
      {
        workspaceID: "workspace-1",
        modelID: "free-auto",
        weekStart: new Date("2026-07-13T00:00:00.000Z"),
        persistedUsage: 1_000,
        reservation: 4_000,
        weeklyLimit: 100_000,
        ttlSeconds: 86_400,
      },
      redis,
      (kind, identifier, interval) => `${kind}:${identifier}:${interval}`,
    )

    expect(quota).toBeDefined()
    expect(calls[0]?.keys).toHaveLength(2)
    expect(calls[0]?.args[4]).toBe(86_400)
    const reservationID = calls[0]?.args[0]
    expect(typeof reservationID).toBe("string")

    await quota!.settle(3_500)
    await quota!.settle(0)

    expect(calls).toHaveLength(2)
    expect(calls[1]?.args).toEqual([reservationID, 3_500, 86_400])
  })

  test("keeps the conservative reservation when settlement has no trusted usage", async () => {
    const calls: Array<{ args: unknown[] }> = []
    const redis = {
      async eval(_script: string, _keys: string[], args: unknown[]) {
        calls.push({ args })
        return calls.length === 1 ? [1, 2_000] : 2_000
      },
    }
    const quota = await reserveFreeAutoQuota(
      {
        workspaceID: "workspace-1",
        modelID: "free-auto",
        weekStart: new Date("2026-07-13T00:00:00.000Z"),
        persistedUsage: 0,
        reservation: 2_000,
        weeklyLimit: 100_000,
        ttlSeconds: 7_200,
      },
      redis,
      (kind, identifier, interval) => `${kind}:${identifier}:${interval}`,
    )

    await quota!.settle()

    expect(calls[1]?.args[1]).toBe(2_000)
  })
})
