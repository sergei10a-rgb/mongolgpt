import { describe, expect, test } from "bun:test"
import {
  executeQuotaLedgerCommand,
  QuotaLedgerRequestSchema,
  sweepQuotaLedger,
  UsageQueueEventSchema,
  type QuotaLedgerStorage,
} from "../src/quota"

class MemoryStorage implements QuotaLedgerStorage {
  data = new Map<string, unknown>()

  async get<T>(key: string) {
    return this.data.get(key) as T | undefined
  }

  async put<T>(key: string, value: T) {
    this.data.set(key, value)
  }

  async delete(key: string) {
    return this.data.delete(key)
  }

  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.data.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>)
  }
}

describe("Cloudflare quota ledger", () => {
  test("reserves and settles Free Auto usage idempotently", async () => {
    const storage = new MemoryStorage()
    const reservationID = "f35be918-4ead-4e6b-bef0-d0cb377ad8c3"
    const expiresAt = 2_000
    const reserve = {
      type: "reserve" as const,
      counterKey: "weekly",
      reservationID,
      persistedUsage: 1_000,
      amount: 4_000,
      limit: 10_000,
      expiresAt,
    }

    await expect(executeQuotaLedgerCommand(storage, reserve, 1_000)).resolves.toEqual({
      allowed: true,
      value: 5_000,
    })
    await expect(executeQuotaLedgerCommand(storage, reserve, 1_000)).resolves.toEqual({
      allowed: true,
      value: 5_000,
    })
    await expect(
      executeQuotaLedgerCommand(
        storage,
        {
          type: "settle",
          counterKey: "weekly",
          reservationID,
          actual: 3_500,
          expiresAt,
        },
        1_100,
      ),
    ).resolves.toEqual({ value: 4_500 })
    await expect(
      executeQuotaLedgerCommand(
        storage,
        {
          type: "settle",
          counterKey: "weekly",
          reservationID,
          actual: 0,
          expiresAt,
        },
        1_100,
      ),
    ).resolves.toEqual({ value: 4_500 })
  })

  test("rejects a reservation above the weekly limit", async () => {
    const storage = new MemoryStorage()
    await expect(
      executeQuotaLedgerCommand(
        storage,
        {
          type: "reserve",
          counterKey: "weekly",
          reservationID: "54fed70c-3a7b-473b-b9eb-40f06bf447dd",
          persistedUsage: 9_000,
          amount: 2_000,
          limit: 10_000,
          expiresAt: 2_000,
        },
        1_000,
      ),
    ).resolves.toEqual({ allowed: false, value: 9_000 })
  })

  test("claims IP limits atomically and doubles the allowance only for new users", async () => {
    const storage = new MemoryStorage()
    const command = {
      type: "ip-claim" as const,
      dailyKey: "daily",
      lifetimeKey: "lifetime",
      dailyLimit: 2,
      dailyExpiresAt: 86_400_000,
    }

    await expect(executeQuotaLedgerCommand(storage, command, 1_000)).resolves.toMatchObject({
      allowed: true,
      isNew: true,
      daily: 1,
      lifetime: 1,
    })
    await executeQuotaLedgerCommand(storage, command, 1_000)
    await executeQuotaLedgerCommand(storage, command, 1_000)
    await executeQuotaLedgerCommand(storage, command, 1_000)
    await expect(executeQuotaLedgerCommand(storage, command, 1_000)).resolves.toMatchObject({
      allowed: false,
      daily: 4,
    })
  })

  test("sweeps expired state and retains lifetime counters", async () => {
    const storage = new MemoryStorage()
    await executeQuotaLedgerCommand(
      storage,
      {
        type: "increment",
        changes: [
          { key: "short", amount: 1, expiresAt: 1_500 },
          { key: "lifetime", amount: 1, expiresAt: null },
        ],
      },
      1_000,
    )

    await expect(sweepQuotaLedger(storage, 2_000)).resolves.toBeUndefined()
    await expect(
      executeQuotaLedgerCommand(storage, { type: "read", keys: ["short", "lifetime"] }, 2_000),
    ).resolves.toEqual({ values: { short: 0, lifetime: 1 } })
  })

  test("validates internal requests and queued usage payloads", () => {
    expect(
      QuotaLedgerRequestSchema.safeParse({
        scope: "workspace:one",
        command: { type: "claim", key: "minute", amount: 1, limit: 10, expiresAt: 2_000 },
      }).success,
    ).toBe(true)
    expect(
      UsageQueueEventSchema.safeParse({
        version: 1,
        id: "usage_1",
        workspaceID: "workspace_1",
        userID: "user_1",
        timeCreated: 1_000,
        workspaceCost: 1,
        userCost: 1,
        usage: {
          model: "free-auto",
          provider: "nvidia",
          inputTokens: -1,
          outputTokens: 1,
          cost: 1,
        },
      }).success,
    ).toBe(false)
  })
})
