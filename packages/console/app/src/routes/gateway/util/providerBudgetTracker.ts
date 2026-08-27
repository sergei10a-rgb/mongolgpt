import { centsToMicroCents } from "@mongolgpt/console-core/util/price.js"
import { buildRateLimitKey, ledgerCommand, numberRecord } from "./quota-service"
import { logger } from "./logger"

export function createProviderBudgetTracker(
  providers: {
    id: string
    budget?: number
    budgetContribution?: number
    budgetMode?: "always" | "fill"
  }[],
) {
  const tracked = providers.filter(
    (provider) => provider.budget !== undefined && provider.budgetContribution !== undefined,
  )
  if (tracked.length === 0) return undefined

  const interval = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .substring(0, 12)
  const scope = `provider-budget:${interval}`
  const expiresAt = Date.now() + 120_000
  const keys = Object.fromEntries(
    tracked.map((provider) => [provider.id, buildRateLimitKey("provider-budget", provider.id, interval)]),
  )
  let budgetUsage: Record<string, number> = {}

  return {
    check: async () => {
      const ids = tracked.map((provider) => provider.id)
      if (ids.length === 0) return {}
      const result = numberRecord(
        await ledgerCommand(scope, {
          type: "read",
          keys: ids.map((id) => keys[id]),
        }),
      )
      budgetUsage = Object.fromEntries(ids.map((id) => [id, result[keys[id]] ?? 0]))
      return budgetUsage
    },
    track: async (provider: string, costInCent: number) => {
      const config = tracked.find((item) => item.id === provider)
      if (!config) return
      if (config.budgetContribution === undefined) return
      const cost = centsToMicroCents(costInCent * config.budgetContribution)
      if (cost <= 0) return
      await ledgerCommand(scope, {
        type: "increment",
        changes: [{ key: keys[provider], amount: cost, expiresAt }],
      })
      logger.metric({
        "provider.budget_usage": (budgetUsage[provider] ?? 0) + cost,
        "model.budget_usage": cost,
      })
    },
  }
}
