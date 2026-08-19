import type { PlatformAccountAPI } from "@/context/platform"
import {
  hostedAccountGateEnabled,
  hostedLoginUrl,
  hostedLogoutUrl,
  hostedRemoteOrigin,
  loadHostedSession,
} from "./hosted-account-gate"

type HostedAccountPlatformInput = {
  mode?: string
  runtimeUrl?: string
  publicOrigin?: string
  navigate?: (url: string) => void
  loadSession?: typeof loadHostedSession
}

export function createHostedAccountPlatform(input: HostedAccountPlatformInput): PlatformAccountAPI | undefined {
  const runtimeUrl = input.runtimeUrl?.trim()
  const publicOrigin = input.publicOrigin?.trim()
  if (!runtimeUrl || !publicOrigin || !hostedAccountGateEnabled(input.mode, runtimeUrl)) return

  const accountUrl = hostedRemoteOrigin(publicOrigin)
  const runtimeOrigin = hostedRemoteOrigin(runtimeUrl)
  if (!accountUrl || !runtimeOrigin) return

  const navigate = input.navigate ?? ((url: string) => window.location.assign(url))
  const loadSession = input.loadSession ?? loadHostedSession
  const pendingNavigation = () => new Promise<never>(() => {})

  return {
    current: async () => {
      const session = await loadSession(runtimeOrigin, accountUrl)
      if (!session.authenticated) return null
      return { ...session.account, url: accountUrl }
    },
    login: async () => {
      navigate(hostedLoginUrl(accountUrl))
      return pendingNavigation()
    },
    logout: async () => {
      navigate(hostedLogoutUrl(accountUrl))
      await pendingNavigation()
    },
  }
}
