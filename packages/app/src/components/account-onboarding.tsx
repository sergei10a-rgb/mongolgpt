import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import { ProviderIcon } from "@mongolgpt/ui/provider-icon"
import { type Accessor, createEffect, createResource, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform, type PlatformAccount } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { accountOnboardingStage, desktopAccountOnboardingReady } from "./account-onboarding-state"
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
  const [overview, { refetch: refetchOverview }] = createResource(
    () => {
      const api = platform.account
      const current = account()
      if (!api?.switchWorkspace || !current || current.activeOrgID) return undefined
      return { api, accountID: current.id }
    },
    async ({ api, accountID }) => {
      const value = await api.overview()
      if (value.account.id !== accountID) throw new Error("Аккаунтын мэдээлэл зөрүүтэй байна")
      return value
    },
  )

  const signedIn = () => account() !== null && account() !== undefined
  const connected = () => Boolean(account()?.activeOrgID?.trim())
  const ready = () =>
    desktopAccountOnboardingReady({
      platform: platform.platform,
      accountAvailable: platform.account !== undefined,
      localServer: ServerConnection.local(server.current),
      storageReady: storageReady(),
      accountLoading: account.loading,
      syncReady: sync().data.ready,
    })

  const login = async () => {
    if (!platform.account) throw new Error(language.t("onboarding.account.loginError"))
    const loggedIn = await platform.account.login()
    setAccount(loggedIn)
    const [, providerRefresh] = await Promise.allSettled([Promise.resolve(refetchAccount()), sync().refreshGlobal()])
    return { connected: Boolean(loggedIn.activeOrgID?.trim()), synced: providerRefresh.status === "fulfilled" }
  }

  const switchWorkspace = async (workspaceID: string) => {
    if (!platform.account?.switchWorkspace) throw new Error(language.t("onboarding.workspace.selectError"))
    const selected = await platform.account.switchWorkspace(workspaceID)
    if (!selected.activeOrgID?.trim()) throw new Error(language.t("onboarding.workspace.selectError"))
    setAccount(selected)
    const [, providerRefresh] = await Promise.allSettled([Promise.resolve(refetchAccount()), sync().refreshGlobal()])
    return providerRefresh.status === "fulfilled"
  }

  createEffect(() => {
    const stage = accountOnboardingStage({
      ready: ready(),
      signedIn: signedIn(),
      connected: connected(),
      completed: state.completed,
    })
    if (!stage || gate.shown) return
    setGate("shown", true)
    void dialog.show(
      () => (
        <DialogAccountOnboarding
          account={() => account()}
          connected={connected}
          accountStatusError={() => account.error !== undefined}
          workspaceOverview={() => overview()}
          workspaceLoading={() => overview.loading}
          workspaceStatusError={() => overview.error !== undefined || platform.account?.switchWorkspace === undefined}
          onLogin={login}
          onSwitchWorkspace={switchWorkspace}
          onRetryAccount={async () => {
            await refetchAccount()
          }}
          onRetryWorkspaces={async () => {
            await refetchOverview()
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
  account: Accessor<PlatformAccount | null | undefined>
  connected: Accessor<boolean>
  accountStatusError: Accessor<boolean>
  workspaceOverview: Accessor<
    | {
        workspaces: ReadonlyArray<{ id: string; name: string }>
      }
    | undefined
  >
  workspaceLoading: Accessor<boolean>
  workspaceStatusError: Accessor<boolean>
  onLogin: () => Promise<{ connected: boolean; synced: boolean }>
  onSwitchWorkspace: (workspaceID: string) => Promise<boolean>
  onRetryAccount: () => Promise<void>
  onRetryWorkspaces: () => Promise<void>
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
    workspacePending: "",
    syncPending: false,
    syncError: false,
    error: "",
  })
  const signedIn = () => props.account() !== null && props.account() !== undefined
  const connected = () => state.connected || props.connected()
  const stage = () =>
    accountOnboardingStage({
      ready: true,
      signedIn: signedIn(),
      connected: connected(),
      completed: false,
    })

  const login = async () => {
    setState({ loginPending: true, error: "" })
    try {
      const result = await props.onLogin()
      setState({ connected: result.connected, syncError: !result.synced })
    } catch {
      setState("error", language.t("onboarding.account.loginError"))
    } finally {
      setState("loginPending", false)
    }
  }

  const switchWorkspace = async (workspaceID: string) => {
    setState({ workspacePending: workspaceID, error: "" })
    try {
      const synced = await props.onSwitchWorkspace(workspaceID)
      setState({ connected: true, syncError: !synced })
    } catch {
      setState("error", language.t("onboarding.workspace.selectError"))
    } finally {
      setState("workspacePending", "")
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
    void dialog.push(() => (
      <DialogConnectProvider provider="nvidia" back="close" onConnected={() => setState("nvidiaConnected", true)} />
    ))
  }

  const connectLocal = () => {
    void dialog.push(() => <DialogCustomProvider back="close" />)
  }

  return (
    <Dialog title={language.t("onboarding.account.title")} transition>
      <div class="flex flex-col gap-6 px-2.5 pb-3" data-mongolgpt-account-onboarding-stage={stage()}>
        <Switch>
          <Match when={!signedIn()}>
            <div class="px-2.5 pb-8 flex flex-col gap-6">
              <div class="flex items-center gap-4">
                <ProviderIcon id="mongolgpt" class="size-8 shrink-0 icon-strong-base" />
                <div class="flex min-w-0 flex-col gap-1">
                  <div class="text-16-medium text-text-strong" data-mongolgpt-account-login-heading>
                    {language.t("onboarding.account.heading")}
                  </div>
                  <p class="text-14-regular text-text-base">{language.t("onboarding.account.description")}</p>
                </div>
              </div>
              <Show when={state.error || props.accountStatusError()}>
                <p class="text-13-regular text-icon-critical-base">
                  {state.error || language.t("onboarding.account.statusError")}
                </p>
              </Show>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  size="large"
                  variant="primary"
                  onClick={login}
                  disabled={state.loginPending}
                  data-mongolgpt-account-login-action
                >
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
          <Match when={signedIn() && !connected()}>
            <div class="px-2.5 pb-6 flex flex-col gap-5">
              <div class="flex flex-col gap-1">
                <div class="text-16-medium text-text-strong">{language.t("onboarding.workspace.heading")}</div>
                <p class="text-14-regular text-text-base">{language.t("onboarding.workspace.description")}</p>
              </div>

              <Show when={state.error || props.workspaceStatusError()}>
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-13-regular text-icon-critical-base" role="alert">
                    {state.error || language.t("onboarding.workspace.loadError")}
                  </p>
                  <Button
                    size="normal"
                    variant="secondary"
                    onClick={() => void props.onRetryWorkspaces()}
                    disabled={state.retryPending}
                  >
                    {language.t("onboarding.account.retry")}
                  </Button>
                </div>
              </Show>

              <Show
                when={!props.workspaceLoading()}
                fallback={
                  <p class="text-14-regular text-text-weak" role="status" aria-live="polite">
                    {language.t("onboarding.workspace.loading")}
                  </p>
                }
              >
                <Show
                  when={props.workspaceOverview()?.workspaces.length}
                  fallback={<p class="text-14-regular text-text-weak">{language.t("onboarding.workspace.empty")}</p>}
                >
                  <div class="flex flex-col border-y border-border-weak-base">
                    <For each={props.workspaceOverview()?.workspaces ?? []}>
                      {(workspace) => (
                        <div class="flex min-h-16 items-center justify-between gap-4 border-b border-border-weak-base py-3 last:border-none">
                          <span class="min-w-0 break-words text-14-medium text-text-strong">{workspace.name}</span>
                          <Button
                            size="normal"
                            variant="secondary"
                            onClick={() => void switchWorkspace(workspace.id)}
                            disabled={state.workspacePending !== ""}
                          >
                            {state.workspacePending === workspace.id
                              ? language.t("onboarding.workspace.selecting")
                              : language.t("onboarding.workspace.select")}
                          </Button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
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
