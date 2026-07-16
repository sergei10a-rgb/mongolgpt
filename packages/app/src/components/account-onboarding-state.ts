export type AccountOnboardingStage = "account" | "providers"

export function accountOnboardingStage(input: {
  ready: boolean
  connected: boolean
  completed: boolean
}): AccountOnboardingStage | undefined {
  if (!input.ready || input.completed) return
  if (!input.connected) return "account"
  return "providers"
}
