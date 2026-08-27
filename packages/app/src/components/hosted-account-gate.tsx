import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import {
  type ParentProps,
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { useLanguage } from "@/context/language"
import { resolveWebRuntime, type WebRuntime } from "@/utils/web-runtime"
import { Splash } from "@mongolgpt/ui/logo"

export type HostedAccount = { id: string; email: string }
export type HostedWorkspace = { id: string; name: string }
export type HostedSession =
  | { authenticated: true; account: HostedAccount; workspace: HostedWorkspace; expiresAt: number }
  | { authenticated: false }
  | {
      authenticated: true
      account: HostedAccount
      workspaceRequired: true
      forbidden: boolean
      workspaces: HostedWorkspace[]
    }

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

const HOSTED_WORKSPACE_KEY = "mongolgpt.hosted.workspace.v1"
const HOSTED_WORKSPACE_EVENT = "mongolgpt:hosted-workspace"

export function hostedSessionUrl(runtimeUrl: string) {
  return new URL("/auth/session", requiredHostedOrigin(runtimeUrl)).toString()
}

export function hostedRuntimeTokenUrl(publicOrigin: string) {
  return new URL("/auth/runtime-token", requiredHostedOrigin(publicOrigin)).toString()
}

export function hostedLoginUrl(publicOrigin: string) {
  const url = new URL("/auth/authorize", requiredHostedOrigin(publicOrigin))
  url.searchParams.set("continue", "/auth/app")
  return url.toString()
}

export function hostedLogoutUrl(publicOrigin: string) {
  return new URL("/auth/logout", requiredHostedOrigin(publicOrigin)).toString()
}

export function hostedAccountGateEnabled(mode: string | undefined, runtimeUrl: string | undefined) {
  if (mode === "local-bridge") return false
  return hostedRemoteOrigin(runtimeUrl) !== undefined
}

export function hostedRemoteOrigin(value: string | undefined) {
  if (!value?.trim()) return
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) return
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (privateHostname(hostname)) return
    return url.origin
  } catch {
    return
  }
}

export async function loadHostedSession(
  runtimeUrl: string,
  publicOrigin: string,
  workspaceID?: string,
): Promise<HostedSession> {
  const runtimeOrigin = requiredHostedOrigin(runtimeUrl)
  const accountOrigin = requiredHostedOrigin(publicOrigin)
  const capabilityResponse = await fetch(hostedRuntimeTokenUrl(accountOrigin), {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(workspaceID ? { "X-Org-ID": workspaceID } : {}),
    },
  })

  if (capabilityResponse.status === 401) return { authenticated: false }
  if (capabilityResponse.status === 403 || capabilityResponse.status === 409) {
    const selection = await jsonResponse(capabilityResponse, [403, 409])
    if (!isWorkspaceSelection(selection)) throw new Error("Ажлын талбарын сонголтын хариу буруу байна")
    return {
      authenticated: true,
      account: selection.account,
      workspaceRequired: true,
      forbidden: capabilityResponse.status === 403,
      workspaces: selection.workspaces,
    }
  }
  const capability = await jsonResponse(capabilityResponse)
  if (!isRuntimeCapability(capability)) throw new Error("Байршуулсан ажиллах орчны токены хариу буруу байна")

  const sessionResponse = await fetch(hostedSessionUrl(runtimeOrigin), {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${capability.token}`,
    },
  })

  if (sessionResponse.status === 401) throw new Error("Байршуулсан ажиллах орчин шинэ эрхийн токеныг хүлээж авсангүй")
  const session = await jsonResponse(sessionResponse)
  if (
    !record(session) ||
    session.authenticated !== true ||
    !record(session.account) ||
    Object.keys(session.account).length !== 1 ||
    typeof session.account.id !== "string" ||
    session.account.id !== capability.account.id ||
    !record(session.workspace) ||
    Object.keys(session.workspace).length !== 1 ||
    typeof session.workspace.id !== "string" ||
    session.workspace.id !== capability.workspace.id ||
    !expiresAt(session.expiresAt, capability.expiresAt)
  ) {
    throw new Error("Байршуулсан ажиллах орчны сешний хариу буруу байна")
  }

  return {
    authenticated: true,
    account: capability.account,
    workspace: capability.workspace,
    expiresAt: session.expiresAt,
  }
}

async function jsonResponse(response: Response, acceptedStatuses: readonly number[] = []): Promise<unknown> {
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new Error(`Байршуулсан нэвтрэлтийн шалгалт амжилтгүй боллоо (${response.status})`)
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error("Байршуулсан нэвтрэлтийн хариу JSON форматтай биш байна")
  }
  try {
    return await response.json()
  } catch {
    throw new Error("Байршуулсан нэвтрэлтийн JSON хариу буруу байна")
  }
}

function isRuntimeCapability(value: unknown): value is {
  token: string
  expiresAt: number
  account: HostedAccount
  workspace: HostedWorkspace
} {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 4_096 &&
    expiresAt(value.expiresAt) &&
    record(value.account) &&
    Object.keys(value.account).length === 2 &&
    account(value.account) &&
    workspace(value.workspace)
  )
}

function isWorkspaceSelection(value: unknown): value is {
  account: HostedAccount
  workspaces: HostedWorkspace[]
} {
  return (
    record(value) &&
    record(value.account) &&
    account(value.account) &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(workspace)
  )
}

export function isHostedSessionReady(
  value: HostedSession | undefined,
): value is Extract<HostedSession, { workspace: HostedWorkspace }> {
  return value?.authenticated === true && "workspace" in value
}

function isHostedWorkspaceSelection(
  value: HostedSession | undefined,
): value is Extract<HostedSession, { workspaceRequired: true }> {
  return value?.authenticated === true && "workspaceRequired" in value
}

function account(value: Record<string, unknown>): value is HostedAccount {
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 256 &&
    value.id.trim() === value.id &&
    typeof value.email === "string" &&
    value.email.length > 0 &&
    value.email.length <= 320 &&
    value.email.trim() === value.email
  )
}

function workspace(value: unknown): value is HostedWorkspace {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    typeof value.id === "string" &&
    value.id.startsWith("wrk_") &&
    value.id.length >= 5 &&
    value.id.length <= 30 &&
    value.id.trim() === value.id &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 255 &&
    value.name.trim() === value.name
  )
}

export function readHostedWorkspaceID(publicOrigin: string, storage: WorkspaceStorage | undefined = webStorage()) {
  if (!storage) return undefined
  try {
    const value = storage.getItem(hostedWorkspaceKey(publicOrigin))?.trim()
    return value && validHostedWorkspaceID(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function writeHostedWorkspaceID(
  publicOrigin: string,
  workspaceID: string | undefined,
  storage: WorkspaceStorage | undefined = webStorage(),
) {
  const origin = requiredHostedOrigin(publicOrigin)
  const normalized = workspaceID?.trim()
  if (normalized && !validHostedWorkspaceID(normalized)) {
    throw new Error("Ажлын талбарын ID буруу байна")
  }
  try {
    if (storage) {
      if (normalized) storage.setItem(hostedWorkspaceKey(origin), normalized)
      else storage.removeItem(hostedWorkspaceKey(origin))
    }
  } catch {
    // The runtime session remains authoritative even when browser persistence is unavailable.
  }
  if (typeof window === "object") {
    window.dispatchEvent(
      new CustomEvent(HOSTED_WORKSPACE_EVENT, { detail: { publicOrigin: origin, workspaceID: normalized } }),
    )
  }
}

function validHostedWorkspaceID(value: string) {
  return value.startsWith("wrk_") && value.length >= 5 && value.length <= 30
}

function hostedWorkspaceKey(publicOrigin: string) {
  return `${HOSTED_WORKSPACE_KEY}:${requiredHostedOrigin(publicOrigin)}`
}

function webStorage(): WorkspaceStorage | undefined {
  if (typeof window !== "object") return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function expiresAt(value: unknown, maximum?: number): value is number {
  const now = Date.now()
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > now &&
    value <= now + 125_000 &&
    (maximum === undefined || value <= maximum)
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredHostedOrigin(value: string) {
  const origin = hostedRemoteOrigin(value)
  if (!origin) throw new Error("Байршуулсан аккаунтын үндсэн хаяг буруу байна")
  return origin
}

function privateHostname(hostname: string) {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89ab]/.test(hostname) ||
    hostname.startsWith("::ffff:")
  ) {
    return true
  }

  const octets = hostname.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

export function HostedAccountGate(props: ParentProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const runtime = hostedRuntimeFallback()
  const derivedRuntimeUrl = runtime?.serverUrl
  const derivedPublicOrigin = hostedPublicOriginFallback()
  const enabled = hostedAccountGateEnabled(runtime?.mode, derivedRuntimeUrl)
  const runtimeUrl = hostedRemoteOrigin(derivedRuntimeUrl)
  const publicOrigin = hostedRemoteOrigin(derivedPublicOrigin)
  const [shown, setShown] = createSignal(false)
  const [selectedWorkspace, setSelectedWorkspace] = createSignal(
    publicOrigin ? readHostedWorkspaceID(publicOrigin) : undefined,
  )
  const [session, actions] = createResource(
    () =>
      enabled && runtimeUrl && publicOrigin ? ([runtimeUrl, publicOrigin, selectedWorkspace()] as const) : undefined,
    async ([server, publicUrl, workspaceID]) => {
      let current = await loadHostedSession(server, publicUrl, workspaceID)
      if ("workspaceRequired" in current && current.forbidden && workspaceID) {
        writeHostedWorkspaceID(publicUrl, undefined)
        setSelectedWorkspace(undefined)
        current = await loadHostedSession(server, publicUrl)
      }
      if (isHostedSessionReady(current) && current.workspace.id !== workspaceID) {
        writeHostedWorkspaceID(publicUrl, current.workspace.id)
        setSelectedWorkspace(current.workspace.id)
      }
      return current
    },
  )
  const workspaceSelection = () => {
    const current = session()
    return isHostedWorkspaceSelection(current) ? current : undefined
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => void actions.refetch()
  const onVisibilityChange = () => {
    const current = session()
    if (
      document.visibilityState === "visible" &&
      isHostedSessionReady(current) &&
      current.expiresAt - Date.now() <= 30_000
    ) {
      refresh()
    }
  }

  if (enabled) {
    const onWorkspaceChange = (event: Event) => {
      if (!(event instanceof CustomEvent) || !record(event.detail)) return
      if (event.detail.publicOrigin !== publicOrigin) return
      const workspaceID = event.detail.workspaceID
      setSelectedWorkspace(typeof workspaceID === "string" ? workspaceID : undefined)
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener(HOSTED_WORKSPACE_EVENT, onWorkspaceChange)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener(HOSTED_WORKSPACE_EVENT, onWorkspaceChange)
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    })
  }

  createEffect(() => {
    const current = session()
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    if (!isHostedSessionReady(current)) return
    refreshTimer = setTimeout(refresh, Math.max(1_000, current.expiresAt - Date.now() - 15_000))
  })

  createEffect(() => {
    if (!enabled || session.loading) return
    const authenticated = !session.error && isHostedSessionReady(session())
    if (authenticated) {
      if (shown()) dialog.close()
      return
    }
    if (shown()) return
    setShown(true)
    void dialog.show(
      () => (
        <Dialog title={language.t("auth.hosted.title")} action={<span />} transition>
          <div class="flex flex-col gap-5 px-2.5 pb-3">
            <Switch>
              <Match when={session.error}>
                <p class="text-14-regular text-text-base">{language.t("auth.hosted.unavailable")}</p>
                <Button size="large" variant="primary" onClick={() => void actions.refetch()}>
                  {language.t("auth.hosted.retry")}
                </Button>
              </Match>
              <Match when={session()?.authenticated === false}>
                <p class="text-14-regular text-text-base">{language.t("auth.hosted.description")}</p>
                <Button
                  size="large"
                  variant="primary"
                  onClick={() => {
                    if (!publicOrigin) return
                    window.location.assign(hostedLoginUrl(publicOrigin))
                  }}
                  disabled={!publicOrigin}
                >
                  {language.t("auth.hosted.login")}
                </Button>
              </Match>
              <Match when={session()?.authenticated === true && !isHostedSessionReady(session())}>
                <p class="text-14-regular text-text-base">{language.t("onboarding.workspace.description")}</p>
                <Show
                  when={workspaceSelection()?.workspaces.length}
                  fallback={<p class="text-14-regular text-text-weak">{language.t("onboarding.workspace.empty")}</p>}
                >
                  <div class="flex flex-col border-y border-border-weak-base">
                    <For each={workspaceSelection()?.workspaces ?? []}>
                      {(workspace) => (
                        <div class="flex min-h-16 items-center justify-between gap-4 border-b border-border-weak-base py-3 last:border-none">
                          <span class="min-w-0 break-words text-14-medium text-text-strong">{workspace.name}</span>
                          <Button
                            size="normal"
                            variant="secondary"
                            onClick={() => {
                              if (!publicOrigin) return
                              writeHostedWorkspaceID(publicOrigin, workspace.id)
                              setSelectedWorkspace(workspace.id)
                            }}
                            disabled={session.loading}
                          >
                            {language.t("onboarding.workspace.select")}
                          </Button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Match>
            </Switch>
          </div>
        </Dialog>
      ),
      () => setShown(false),
    )
  })

  return (
    <Show
      when={!enabled || (!session.error && isHostedSessionReady(session()))}
      fallback={
        <div class="h-dvh w-screen flex items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

function hostedRuntimeFallback(): WebRuntime | undefined {
  if (typeof location !== "object" || typeof location.origin !== "string" || !location.origin) return undefined
  return resolveWebRuntime({
    dev: import.meta.env.DEV,
    origin: location.origin,
    serverHost: import.meta.env.VITE_MONGOLGPT_SERVER_HOST,
    serverPort: import.meta.env.VITE_MONGOLGPT_SERVER_PORT,
    serverUrl: import.meta.env.VITE_MONGOLGPT_SERVER_URL,
  })
}

function hostedPublicOriginFallback() {
  if (import.meta.env.VITE_MONGOLGPT_PUBLIC_URL?.trim()) return import.meta.env.VITE_MONGOLGPT_PUBLIC_URL.trim()
  if (!isSafeOrigin()) return
  return hostedPublicOriginFromLocation(location.origin)
}

function isSafeOrigin() {
  return (
    typeof location === "object" &&
    typeof location.origin === "string" &&
    location.origin.length > 0 &&
    !(new URL(location.origin).hostname === "localhost" || new URL(location.origin).hostname === "127.0.0.1")
  )
}

function hostedPublicOriginFromLocation(appOrigin: string) {
  const parsed = new URL(appOrigin)
  const host = parsed.hostname
  const parts = host.split(".")
  if (parts[0] !== "app" || parts.length < 2) return appOrigin
  const publicHost = parts.slice(1).join(".")
  return `${parsed.protocol}://${publicHost}${parsed.port ? `:${parsed.port}` : ""}`
}
