import type { PlatformAccountAPI } from "@/context/platform"
import { AccountOverviewSchema } from "@mongolgpt/account-contract"
import {
  hostedAccountGateEnabled,
  hostedLoginUrl,
  hostedLogoutUrl,
  hostedRemoteOrigin,
  isHostedSessionReady,
  loadHostedSession,
  readHostedWorkspaceID,
  writeHostedWorkspaceID,
} from "./hosted-account-gate"

type HostedAccountPlatformInput = {
  mode?: string
  runtimeUrl?: string
  publicOrigin?: string
  navigate?: (url: string) => void
  loadSession?: typeof loadHostedSession
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
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
  const selectedWorkspace = () => readHostedWorkspaceID(accountUrl, input.storage)
  const session = async (workspaceID = selectedWorkspace()) => {
    let current = await loadSession(runtimeOrigin, accountUrl, workspaceID)
    if ("workspaceRequired" in current && current.forbidden && workspaceID) {
      writeHostedWorkspaceID(accountUrl, undefined, input.storage)
      current = await loadSession(runtimeOrigin, accountUrl)
    }
    return current
  }

  return {
    current: async () => {
      const current = await session()
      if (!current.authenticated) return null
      if (!isHostedSessionReady(current)) return { ...current.account, url: accountUrl }
      if (selectedWorkspace() !== current.workspace.id) {
        writeHostedWorkspaceID(accountUrl, current.workspace.id, input.storage)
      }
      return { ...current.account, url: accountUrl, activeOrgID: current.workspace.id }
    },
    overview: async (workspaceID) => {
      const organizationID = workspaceID?.trim() || selectedWorkspace()
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
    switchWorkspace: async (workspaceID) => {
      const requested = workspaceID.trim()
      if (!requested.startsWith("wrk_") || requested.length < 5 || requested.length > 30) {
        throw new Error("Ажлын талбарын ID буруу байна")
      }
      const current = await loadSession(runtimeOrigin, accountUrl, requested)
      if (!isHostedSessionReady(current) || current.workspace.id !== requested) {
        throw new Error("Ажлын талбарт шилжиж чадсангүй")
      }
      writeHostedWorkspaceID(accountUrl, requested, input.storage)
      return { ...current.account, url: accountUrl, activeOrgID: requested }
    },
    logout: async () => {
      writeHostedWorkspaceID(accountUrl, undefined, input.storage)
      navigate(hostedLogoutUrl(accountUrl))
      await pendingNavigation()
    },
  }
}
