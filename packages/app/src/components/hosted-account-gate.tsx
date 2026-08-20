import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import { type ParentProps, createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { Splash } from "@mongolgpt/ui/logo"

type HostedAccount = { id: string; email: string }
type HostedSession = { authenticated: true; account: HostedAccount; expiresAt: number } | { authenticated: false }

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

export async function loadHostedSession(runtimeUrl: string, publicOrigin: string): Promise<HostedSession> {
  const runtimeOrigin = requiredHostedOrigin(runtimeUrl)
  const accountOrigin = requiredHostedOrigin(publicOrigin)
  const capabilityResponse = await fetch(hostedRuntimeTokenUrl(accountOrigin), {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  })

  if (capabilityResponse.status === 401) return { authenticated: false }
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

  if (sessionResponse.status === 401)
    throw new Error("Байршуулсан ажиллах орчин шинэ эрхийн токеныг хүлээж авсангүй")
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
    throw new Error("Байршуулсан ажиллах орчны сешний хариу буруу байна")
  }

  return { authenticated: true, account: capability.account, expiresAt: session.expiresAt }
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Байршуулсан нэвтрэлтийн шалгалт амжилтгүй боллоо (${response.status})`)
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error("Байршуулсан нэвтрэлтийн хариу JSON форматтай биш байна")
  }
  try {
    return await response.json()
  } catch {
    throw new Error("Байршуулсан нэвтрэлтийн JSON хариу буруу байна")
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
  const derivedRuntimeUrl = hostedRuntimeUrlFallback()
  const derivedPublicOrigin = hostedPublicOriginFallback()
  const enabled = hostedAccountGateEnabled(
    import.meta.env.VITE_MONGOLGPT_RUNTIME_MODE ?? (derivedRuntimeUrl ? "hosted" : "local-bridge"),
    derivedRuntimeUrl,
  )
  const runtimeUrl = derivedRuntimeUrl
  const publicOrigin = derivedPublicOrigin
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

function hostedRuntimeUrlFallback() {
  if (import.meta.env.VITE_MONGOLGPT_SERVER_URL?.trim()) return import.meta.env.VITE_MONGOLGPT_SERVER_URL.trim()
  if (!isSafeOrigin()) return
  const parsed = new URL(location.origin)
  if (parsed.protocol !== "https:") return
  const host = parsed.hostname
  const parts = host.split(".")
  if (parts[0] !== "app" || parts.length < 2) return
  const runtimeHost = `runtime.${parts.slice(1).join(".")}`
  const port = parsed.port ? `:${parsed.port}` : ""
  return `${parsed.protocol}//${runtimeHost}${port}`.replace(/\/+$/, "")
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
