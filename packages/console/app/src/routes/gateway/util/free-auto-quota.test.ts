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
    const calls: Array<{ scope: string; command: Record<string, unknown> }> = []
    const client = async (scope: string, command: Record<string, unknown>) => {
      calls.push({ scope, command })
      return command.type === "reserve" ? { allowed: true, value: 5_000 } : { value: 4_500 }
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
      client,
    )

    expect(quota).toBeDefined()
    expect(calls[0]?.scope).toContain("workspace-1:free-auto:2026-07-13")
    expect(Number(calls[0]?.command.expiresAt)).toBeGreaterThan(Date.now())
    const reservationID = calls[0]?.command.reservationID
    expect(typeof reservationID).toBe("string")

    await quota!.settle(3_500)
    await quota!.settle(0)

    expect(calls).toHaveLength(2)
    expect(calls[1]?.command).toMatchObject({
      type: "settle",
      reservationID,
      actual: 3_500,
    })
  })

  test("keeps the conservative reservation when settlement has no trusted usage", async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = async (_scope: string, command: Record<string, unknown>) => {
      calls.push(command)
      return command.type === "reserve" ? { allowed: true, value: 2_000 } : { value: 2_000 }
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
      client,
    )

    await quota!.settle()

    expect(calls[1]?.actual).toBe(2_000)
  })

  test("fails closed when provider usage exceeds the reserved request bound", async () => {
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
      async (_scope, command) =>
        command.type === "reserve"
          ? { allowed: true, value: 2_000 }
          : { deactivated: true, overrun: true, value: 2_000 },
    )

    await expect(quota!.settle(2_001)).rejects.toThrow("нөөцөлсөн хэмжээнээс хэтэрлээ")
  })
})
