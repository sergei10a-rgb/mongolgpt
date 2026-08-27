export type AccountOnboardingStage = "account" | "workspace" | "providers"

export function accountOnboardingStage(input: {
  ready: boolean
  signedIn: boolean
  connected: boolean
  completed: boolean
}): AccountOnboardingStage | undefined {
  if (!input.ready || input.completed) return undefined
  if (!input.signedIn) return "account"
  if (!input.connected) return "workspace"
  return "providers"
}
