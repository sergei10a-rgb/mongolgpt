export type AccountOnboardingStage = "account" | "workspace" | "providers"

export function desktopAccountOnboardingReady(input: {
  platform: string
  accountAvailable: boolean
  localServer: boolean
  storageReady: boolean
  accountLoading: boolean
  syncReady: boolean
}) {
  return (
    input.platform === "desktop" &&
    input.accountAvailable &&
    input.localServer &&
    input.storageReady &&
    !input.accountLoading &&
    input.syncReady
  )
}

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
