import type { PlatformAccountAPI } from "@/context/platform"
import { AccountOverviewSchema } from "@mongolgpt/account-contract"
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
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const accountOverviewUnavailable = () => new Error("Бүртгэлийн төлөвийг авах боломжгүй байна")

export function createHostedAccountPlatform(input: HostedAccountPlatformInput): PlatformAccountAPI | undefined {
  const runtimeUrl = input.runtimeUrl?.trim()
  const publicOrigin = input.publicOrigin?.trim()
  if (!runtimeUrl || !publicOrigin || !hostedAccountGateEnabled(input.mode, runtimeUrl)) return

  const accountUrl = hostedRemoteOrigin(publicOrigin)
  const runtimeOrigin = hostedRemoteOrigin(runtimeUrl)
  if (!accountUrl || !runtimeOrigin) return

  const navigate = input.navigate ?? ((url: string) => window.location.assign(url))
  const loadSession = input.loadSession ?? loadHostedSession
  const fetcher = input.fetch ?? fetch
  const pendingNavigation = () => new Promise<never>(() => {})

  return {
    current: async () => {
      const session = await loadSession(runtimeOrigin, accountUrl)
      if (!session.authenticated) return null
      return { ...session.account, url: accountUrl }
    },
    overview: async (workspaceID) => {
      const organizationID = workspaceID?.trim()
      let response: Response
      try {
        response = await fetcher(`${accountUrl}/v1/account/overview`, {
          credentials: "include",
          headers: {
            Accept: "application/json",
            ...(organizationID ? { "X-Org-ID": organizationID } : {}),
          },
        })
      } catch {
        throw accountOverviewUnavailable()
      }

      if (!response.ok) throw accountOverviewUnavailable()
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      if (contentType !== "application/json") throw accountOverviewUnavailable()

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw accountOverviewUnavailable()
      }

      try {
        return AccountOverviewSchema.parse(body)
      } catch {
        throw accountOverviewUnavailable()
      }
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
