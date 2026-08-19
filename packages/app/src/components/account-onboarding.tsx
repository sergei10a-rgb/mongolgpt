import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import { ProviderIcon } from "@mongolgpt/ui/provider-icon"
import { type Accessor, createEffect, createResource, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { accountOnboardingStage } from "./account-onboarding-state"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { DialogCustomProvider } from "./dialog-custom-provider"

export function AccountOnboardingGate() {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const sync = useServerSync()
  const [state, setState, , storageReady] = persisted(
    Persist.global("account-onboarding.v2"),
    createStore({ completed: false }),
  )
  const [gate, setGate] = createStore({ shown: false })
  const [account, { mutate: setAccount, refetch: refetchAccount }] = createResource(
    () => platform.account?.current() ?? null,
  )

  const connected = () => account.latest !== null && account.latest !== undefined
  const ready = () =>
    platform.platform === "desktop" &&
    platform.account !== undefined &&
    ServerConnection.local(server.current) &&
    storageReady() &&
    !account.loading &&
    sync().data.ready &&
    sync().data.provider.all.has("mongolgpt")

  const login = async () => {
    if (!platform.account) throw new Error(language.t("onboarding.account.loginError"))
    const loggedIn = await platform.account.login()
    setAccount(loggedIn)
    const [, providerRefresh] = await Promise.allSettled([Promise.resolve(refetchAccount()), sync().refreshGlobal()])
    return providerRefresh.status === "fulfilled"
  }

  createEffect(() => {
    const stage = accountOnboardingStage({ ready: ready(), connected: connected(), completed: state.completed })
    if (!stage || gate.shown) return
    setGate("shown", true)
    void dialog.show(
      () => (
        <DialogAccountOnboarding
          connected={connected}
          accountStatusError={() => account.error !== undefined}
          onLogin={login}
          onRetryAccount={async () => {
            await refetchAccount()
          }}
          onRetrySync={() => sync().refreshGlobal()}
          nvidiaAvailable={() => sync().data.provider.all.has("nvidia")}
          onComplete={() => {
            setState("completed", true)
            dialog.close()
          }}
        />
      ),
      () => setGate("shown", false),
    )
  })

  return null
}

function DialogAccountOnboarding(props: {
  connected: Accessor<boolean>
  accountStatusError: Accessor<boolean>
  onLogin: () => Promise<boolean>
  onRetryAccount: () => Promise<void>
  onRetrySync: () => Promise<void>
  nvidiaAvailable: Accessor<boolean>
  onComplete: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({
    connected: false,
    nvidiaConnected: false,
    loginPending: false,
    retryPending: false,
    syncPending: false,
    syncError: false,
    error: "",
  })
  const connected = () => state.connected || props.connected()

  const login = async () => {
    setState({ loginPending: true, error: "" })
    try {
      const synced = await props.onLogin()
      setState({ connected: true, syncError: !synced })
    } catch {
      setState("error", language.t("onboarding.account.loginError"))
    } finally {
      setState("loginPending", false)
    }
  }

  const retrySync = async () => {
    setState("syncPending", true)
    try {
      await props.onRetrySync()
      setState("syncError", false)
    } catch {
      setState("syncError", true)
    } finally {
      setState("syncPending", false)
    }
  }

  const retryAccount = async () => {
    setState({ retryPending: true, error: "" })
    try {
      await props.onRetryAccount()
    } catch {
      setState("error", language.t("onboarding.account.statusError"))
    } finally {
      setState("retryPending", false)
    }
  }

  const connectNvidia = () => {
    dialog.push(() => (
      <DialogConnectProvider provider="nvidia" back="close" onConnected={() => setState("nvidiaConnected", true)} />
    ))
  }

  const connectLocal = () => {
    dialog.push(() => <DialogCustomProvider back="close" />)
  }

  return (
    <Dialog title={language.t("onboarding.account.title")} transition>
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <Switch>
          <Match when={!connected()}>
            <div class="px-2.5 pb-8 flex flex-col gap-6">
              <div class="flex items-center gap-4">
                <ProviderIcon id="mongolgpt" class="size-8 shrink-0 icon-strong-base" />
                <div class="flex min-w-0 flex-col gap-1">
                  <div class="text-16-medium text-text-strong">{language.t("onboarding.account.heading")}</div>
                  <p class="text-14-regular text-text-base">{language.t("onboarding.account.description")}</p>
                </div>
              </div>
              <Show when={state.error || props.accountStatusError()}>
                <p class="text-13-regular text-icon-critical-base">
                  {state.error || language.t("onboarding.account.statusError")}
                </p>
              </Show>
              <div class="flex flex-wrap items-center gap-2">
                <Button size="large" variant="primary" onClick={login} disabled={state.loginPending}>
                  {state.loginPending
                    ? language.t("onboarding.account.loggingIn")
                    : language.t("onboarding.account.login")}
                </Button>
                <Show when={props.accountStatusError()}>
                  <Button size="large" variant="secondary" onClick={retryAccount} disabled={state.retryPending}>
                    {state.retryPending
                      ? language.t("onboarding.account.retrying")
                      : language.t("onboarding.account.retry")}
                  </Button>
                </Show>
              </div>
            </div>
          </Match>
          <Match when={connected()}>
            <div class="px-2.5 pb-6 flex flex-col gap-5">
              <div class="flex flex-col gap-1">
                <div class="text-16-medium text-text-strong">{language.t("onboarding.providers.heading")}</div>
                <p class="text-14-regular text-text-base">{language.t("onboarding.providers.description")}</p>
              </div>

              <Show when={state.syncError}>
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-13-regular text-icon-critical-base">{language.t("onboarding.account.syncError")}</p>
                  <Button size="normal" variant="secondary" onClick={retrySync} disabled={state.syncPending}>
                    {state.syncPending
                      ? language.t("onboarding.account.syncing")
                      : language.t("onboarding.account.syncRetry")}
                  </Button>
                </div>
              </Show>

              <div class="flex flex-col border-y border-border-weak-base">
                <div class="flex min-h-16 items-center justify-between gap-4 py-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <ProviderIcon id="mongolgpt" class="size-5 shrink-0 icon-strong-base" />
                    <div class="min-w-0">
                      <div class="text-14-medium text-text-strong">
                        {language.t("onboarding.providers.freeAuto.title")}
                      </div>
                      <p class="text-12-regular text-text-weak">
                        {language.t("onboarding.providers.freeAuto.description")}
                      </p>
                    </div>
                  </div>
                </div>

                <Show when={props.nvidiaAvailable()}>
                  <div class="flex min-h-16 items-center justify-between gap-4 border-t border-border-weak-base py-3">
                    <div class="flex min-w-0 items-center gap-3">
                      <ProviderIcon id="nvidia" class="size-5 shrink-0 icon-strong-base" />
                      <div class="min-w-0">
                        <div class="text-14-medium text-text-strong">
                          {language.t("onboarding.providers.nvidia.title")}
                        </div>
                        <p class="text-12-regular text-text-weak">
                          {language.t("onboarding.providers.nvidia.description")}
                        </p>
                      </div>
                    </div>
                    <Button size="normal" variant="secondary" onClick={connectNvidia} disabled={state.nvidiaConnected}>
                      {state.nvidiaConnected
                        ? language.t("onboarding.providers.connected")
                        : language.t("common.connect")}
                    </Button>
                  </div>
                </Show>

                <div class="flex min-h-16 items-center justify-between gap-4 border-t border-border-weak-base py-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
                    <div class="min-w-0">
                      <div class="text-14-medium text-text-strong">
                        {language.t("onboarding.providers.local.title")}
                      </div>
                      <p class="text-12-regular text-text-weak">
                        {language.t("onboarding.providers.local.description")}
                      </p>
                    </div>
                  </div>
                  <Button size="normal" variant="secondary" onClick={connectLocal}>
                    {language.t("onboarding.providers.configure")}
                  </Button>
                </div>
              </div>

              <Button class="self-start" size="large" variant="primary" onClick={props.onComplete}>
                {language.t("onboarding.providers.continue")}
              </Button>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
