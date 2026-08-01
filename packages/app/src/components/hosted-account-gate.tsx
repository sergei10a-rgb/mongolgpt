import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import { type ParentProps, createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { Splash } from "@mongolgpt/ui/logo"

type HostedAccount = { id: string; email: string }
type HostedSession = { authenticated: true; account: HostedAccount; expiresAt: number } | { authenticated: false }

export function hostedSessionUrl(runtimeUrl: string) {
  return new URL("/auth/session", `${runtimeUrl.replace(/\/+$/, "")}/`).toString()
}

export function hostedRuntimeTokenUrl(publicOrigin: string) {
  return new URL("/auth/runtime-token", `${publicOrigin.replace(/\/+$/, "")}/`).toString()
}

export function hostedLoginUrl(publicOrigin: string) {
  const url = new URL("/auth/authorize", `${publicOrigin.replace(/\/+$/, "")}/`)
  url.searchParams.set("continue", "/auth/app")
  return url.toString()
}

export function hostedAccountGateEnabled(mode: string | undefined, runtimeUrl: string | undefined) {
  if (mode === "local-bridge") return false
  if (mode === "hosted") return true
  if (!runtimeUrl?.trim()) return false
  try {
    const hostname = new URL(runtimeUrl).hostname
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1"
  } catch {
    return false
  }
}

export async function loadHostedSession(runtimeUrl: string, publicOrigin: string): Promise<HostedSession> {
  const capabilityResponse = await fetch(hostedRuntimeTokenUrl(publicOrigin), {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  })

  if (capabilityResponse.status === 401) return { authenticated: false }
  const capability = await jsonResponse(capabilityResponse)
  if (!isRuntimeCapability(capability)) throw new Error("Hosted runtime token response was invalid")

  const sessionResponse = await fetch(hostedSessionUrl(runtimeUrl), {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${capability.token}`,
    },
  })

  if (sessionResponse.status === 401) throw new Error("Hosted runtime rejected a fresh capability")
  const session = await jsonResponse(sessionResponse)
  if (
    !record(session) ||
    session.authenticated !== true ||
    !record(session.account) ||
    Object.keys(session.account).length !== 1 ||
    typeof session.account.id !== "string" ||
    session.account.id !== capability.account.id ||
    !expiresAt(session.expiresAt, capability.expiresAt)
  ) {
    throw new Error("Hosted runtime session response was invalid")
  }

  return { authenticated: true, account: capability.account, expiresAt: session.expiresAt }
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Hosted auth check failed (${response.status})`)
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error("Hosted auth response was not JSON")
  }
  try {
    return await response.json()
  } catch {
    throw new Error("Hosted auth response was invalid JSON")
  }
}

function isRuntimeCapability(value: unknown): value is { token: string; expiresAt: number; account: HostedAccount } {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 4_096 &&
    expiresAt(value.expiresAt) &&
    record(value.account) &&
    Object.keys(value.account).length === 2 &&
    account(value.account)
  )
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

export function HostedAccountGate(props: ParentProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const enabled = hostedAccountGateEnabled(
    import.meta.env.VITE_MONGOLGPT_RUNTIME_MODE,
    import.meta.env.VITE_MONGOLGPT_SERVER_URL,
  )
  const runtimeUrl = import.meta.env.VITE_MONGOLGPT_SERVER_URL?.trim()
  const publicOrigin = import.meta.env.VITE_MONGOLGPT_PUBLIC_URL?.trim()
  const [shown, setShown] = createSignal(false)
  const [session, actions] = createResource(
    () => (enabled && runtimeUrl && publicOrigin ? ([runtimeUrl, publicOrigin] as const) : undefined),
    ([server, publicUrl]) => loadHostedSession(server, publicUrl),
  )

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => void actions.refetch()
  const onVisibilityChange = () => {
    const current = session()
    if (
      document.visibilityState === "visible" &&
      current?.authenticated === true &&
      current.expiresAt - Date.now() <= 30_000
    ) {
      refresh()
    }
  }

  if (enabled) {
    document.addEventListener("visibilitychange", onVisibilityChange)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    })
  }

  createEffect(() => {
    const current = session()
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    if (current?.authenticated !== true) return
    refreshTimer = setTimeout(refresh, Math.max(1_000, current.expiresAt - Date.now() - 15_000))
  })

  createEffect(() => {
    if (!enabled || session.loading) return
    const authenticated = !session.error && session()?.authenticated === true
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
            <Show
              when={!session.error}
              fallback={
                <>
                  <p class="text-14-regular text-text-base">{language.t("auth.hosted.unavailable")}</p>
                  <Button size="large" variant="primary" onClick={() => void actions.refetch()}>
                    {language.t("auth.hosted.retry")}
                  </Button>
                </>
              }
            >
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
            </Show>
          </div>
        </Dialog>
      ),
      () => setShown(false),
    )
  })

  return (
    <Show
      when={!enabled || (!session.error && session()?.authenticated === true)}
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
