export type BillingSource = "anonymous" | "free" | "byok" | "plan" | "balance"

export function selectByokProviderRoute<T extends { id: string; disabled?: boolean }>(input: {
  hasCredentials: boolean
  byokProvider: string | undefined
  providers: T[]
  catalogProviders: Record<string, { usageMode?: string } | undefined>
}) {
  if (!input.hasCredentials || !input.byokProvider) return undefined
  if (input.catalogProviders[input.byokProvider]?.usageMode !== "byok") return undefined
  return input.providers.find((provider) => provider.id === input.byokProvider && !provider.disabled)
}

export function selectServerProviderRoutes<T extends { id: string; disabled?: boolean }>(
  providers: T[],
  catalogProviders: Record<string, { usageMode?: string } | undefined>,
) {
  return providers.filter((provider) => !provider.disabled && catalogProviders[provider.id]?.usageMode !== "byok")
}

export function resolveImmediateBillingSource(input: {
  authenticated: boolean
  hasProviderCredentials: boolean
  freeForAuthenticated: boolean
  freeWorkspace: boolean
  allowAnonymous: boolean
}): BillingSource | undefined {
  if (!input.authenticated) return input.allowAnonymous ? "anonymous" : undefined
  if (input.hasProviderCredentials) return "byok"
  if (input.freeForAuthenticated || input.freeWorkspace || input.allowAnonymous) return "free"
  return undefined
}

export async function trackAndSettleMeasuredUsage<T>(input: {
  actual: T
  track: () => Promise<unknown>
  settle: (actual: T) => Promise<unknown>
}) {
  try {
    await input.track()
  } finally {
    await input.settle(input.actual)
  }
}
