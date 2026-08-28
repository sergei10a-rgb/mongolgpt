export type BillingSource = "anonymous" | "free" | "byok" | "plan" | "balance"

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
