import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import { type ParentProps, createEffect, createResource, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { Splash } from "@mongolgpt/ui/logo"

type HostedSession = { authenticated: true; account: { id: string; email: string } } | { authenticated: false }

export function hostedSessionUrl(runtimeUrl: string) {
  return new URL("/auth/session", `${runtimeUrl.replace(/\/+$/, "")}/`).toString()
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

async function loadHostedSession(runtimeUrl: string): Promise<HostedSession> {
  const response = await fetch(hostedSessionUrl(runtimeUrl), {
    credentials: "include",
    headers: { Accept: "application/json" },
  })

  if (response.status === 401) return { authenticated: false }
  if (!response.ok) throw new Error(`Hosted session check failed (${response.status})`)

  const value = (await response.json()) as Partial<HostedSession>
  if (value.authenticated === true && value.account?.id && value.account.email) return value as HostedSession
  if (value.authenticated === false) return { authenticated: false }
  throw new Error("Hosted session response was invalid")
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
    () => (enabled && runtimeUrl ? runtimeUrl : undefined),
    (url) => loadHostedSession(url!),
  )

  createEffect(() => {
    if (!enabled || session.loading) return
    if (session()?.authenticated) {
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
      when={!enabled || session()?.authenticated === true}
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
