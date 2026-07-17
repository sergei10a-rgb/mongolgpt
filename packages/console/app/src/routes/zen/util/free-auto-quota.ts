import type { QuotaLedgerCommand } from "@mongolgpt/console-core/quota.js"
import { claimResult, ledgerCommand } from "./quota-service"

type LedgerClient = (scope: string, command: QuotaLedgerCommand) => Promise<unknown>

export function freeAutoReservationUpperBound(maxTokensPerRequest: number, weeklyLimit: number) {
  return Math.min(Math.ceil(maxTokensPerRequest), Math.ceil(weeklyLimit))
}

export async function reserveFreeAutoQuota(
  input: {
    workspaceID: string
    modelID: string
    weekStart: Date
    persistedUsage: number
    reservation: number
    weeklyLimit: number
    ttlSeconds: number
  },
  client: LedgerClient = ledgerCommand,
) {
  const scope = `free-auto:${input.workspaceID}:${input.modelID}:${input.weekStart.toISOString().slice(0, 10)}`
  const counterKey = "weekly-usage"
  const reservationID = crypto.randomUUID()
  const expiresAt = Date.now() + Math.max(60, Math.ceil(input.ttlSeconds)) * 1_000
  const result = claimResult(
    await client(scope, {
      type: "reserve",
      counterKey,
      reservationID,
      persistedUsage: input.persistedUsage,
      amount: input.reservation,
      limit: input.weeklyLimit,
      expiresAt,
    }),
  )
  if (!result.allowed) return

  const state: { settle?: Promise<void> } = {}
  return {
    reservation: input.reservation,
    settle(actualUsage = input.reservation) {
      if (state.settle) return state.settle
      state.settle = client(scope, {
        type: "settle",
        counterKey,
        reservationID,
        actual: Math.max(0, Math.ceil(actualUsage)),
        expiresAt,
      }).then(() => undefined)
      return state.settle
    },
  }
}
