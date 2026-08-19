import { Button } from "@mongolgpt/ui/button"
import { ProviderIcon } from "@mongolgpt/ui/provider-icon"
import { ButtonV2 } from "@mongolgpt/ui/v2/button-v2"
import { createResource, createSignal, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform, type PlatformAccount } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { SettingsList } from "./settings-list"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsRowV2 } from "./settings-v2/parts/row"

export function accountServiceHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function useSettingsAccount() {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const [pending, setPending] = createSignal<"login" | "logout" | "retry">()
  const [operationError, setOperationError] = createSignal(false)
  const [account, actions] = createResource(
    () => platform.account,
    (api) => api.current(),
  )

  const refreshProviders = () => serverSync().refreshGlobal().catch(() => undefined)
  const login = async () => {
    const api = platform.account
    if (!api) return
    setPending("login")
    setOperationError(false)
    try {
      actions.mutate(await api.login())
      await refreshProviders()
    } catch {
      setOperationError(true)
    } finally {
      setPending()
    }
  }
  const logout = async () => {
    const api = platform.account
    if (!api) return
    setPending("logout")
    setOperationError(false)
    try {
      await api.logout()
      actions.mutate(null)
      await refreshProviders()
    } catch {
      setOperationError(true)
    } finally {
      setPending()
    }
  }
  const retry = async () => {
    setPending("retry")
    setOperationError(false)
    try {
      await actions.refetch()
    } catch {
      // The resource exposes the error state below.
    } finally {
      setPending()
    }
  }

  return {
    account,
    error: () => operationError() || account.error !== undefined,
    loading: () => account.loading || pending() === "retry",
    login,
    logout,
    retry,
    loginPending: () => pending() === "login",
    logoutPending: () => pending() === "logout",
    language,
  }
}

function AccountIdentity(props: { account: PlatformAccount }) {
  const language = useLanguage()
  return (
    <div class="flex min-w-0 items-center gap-3">
      <ProviderIcon id="mongolgpt" class="size-5 shrink-0 icon-strong-base" />
      <div class="flex min-w-0 flex-col gap-1">
        <span class="text-14-medium text-text-strong break-all">{props.account.email}</span>
        <span class="text-12-regular text-text-weak break-all">
          {language.t("settings.account.service", { host: accountServiceHost(props.account.url) })}
        </span>
      </div>
    </div>
  )
}

export const SettingsAccount: Component = () => {
  const state = useSettingsAccount()
  return (
    <div class="flex h-full flex-col overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{state.language.t("settings.account.title")}</h2>
        </div>
      </div>
      <div class="flex flex-col gap-1 max-w-[720px]">
        <h3 class="text-14-medium text-text-strong pb-2">{state.language.t("settings.account.identity")}</h3>
        <SettingsList>
          <Show
            when={!state.loading()}
            fallback={<div class="py-5 text-14-regular text-text-weak">{state.language.t("settings.account.loading")}</div>}
          >
            <Show
              when={!state.error()}
              fallback={
                <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
                  <span class="text-14-regular text-icon-critical-base">
                    {state.language.t("settings.account.loadError")}
                  </span>
                  <Button size="large" variant="secondary" disabled={state.loading()} onClick={() => void state.retry()}>
                    {state.language.t("settings.account.retry")}
                  </Button>
                </div>
              }
            >
              <Show
                when={state.account()}
                keyed
                fallback={
                  <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
                    <div class="flex min-w-0 flex-col gap-1">
                      <span class="text-14-medium text-text-strong">{state.language.t("settings.account.signedOut")}</span>
                      <span class="text-12-regular text-text-weak">
                        {state.language.t("settings.account.signedOutDescription")}
                      </span>
                    </div>
                    <Button size="large" variant="primary" disabled={state.loginPending()} onClick={() => void state.login()}>
                      {state.loginPending()
                        ? state.language.t("settings.account.loggingIn")
                        : state.language.t("settings.account.login")}
                    </Button>
                  </div>
                }
              >
                {(current) => (
                  <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
                    <AccountIdentity account={current} />
                    <Button size="large" variant="secondary" disabled={state.logoutPending()} onClick={() => void state.logout()}>
                      {state.logoutPending()
                        ? state.language.t("settings.account.loggingOut")
                        : state.language.t("settings.account.logout")}
                    </Button>
                  </div>
                )}
              </Show>
            </Show>
          </Show>
        </SettingsList>
      </div>
    </div>
  )
}

export const SettingsAccountV2: Component = () => {
  const state = useSettingsAccount()
  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{state.language.t("settings.account.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{state.language.t("settings.account.identity")}</h3>
          <SettingsListV2>
            <Show
              when={!state.loading()}
              fallback={
                <SettingsRowV2
                  title={state.language.t("settings.account.loading")}
                  description={state.language.t("settings.account.loadingDescription")}
                >
                  <span />
                </SettingsRowV2>
              }
            >
              <Show
                when={!state.error()}
                fallback={
                  <SettingsRowV2
                    title={state.language.t("settings.account.loadError")}
                    description={state.language.t("settings.account.loadErrorDescription")}
                  >
                    <ButtonV2 variant="neutral" disabled={state.loading()} onClick={() => void state.retry()}>
                      {state.language.t("settings.account.retry")}
                    </ButtonV2>
                  </SettingsRowV2>
                }
              >
                <Show
                  when={state.account()}
                  keyed
                  fallback={
                    <SettingsRowV2
                      title={state.language.t("settings.account.signedOut")}
                      description={state.language.t("settings.account.signedOutDescription")}
                    >
                      <ButtonV2 variant="contrast" disabled={state.loginPending()} onClick={() => void state.login()}>
                        {state.loginPending()
                          ? state.language.t("settings.account.loggingIn")
                          : state.language.t("settings.account.login")}
                      </ButtonV2>
                    </SettingsRowV2>
                  }
                >
                  {(current) => (
                    <SettingsRowV2
                      title={current.email}
                      description={state.language.t("settings.account.service", {
                        host: accountServiceHost(current.url),
                      })}
                    >
                      <ButtonV2 variant="danger" disabled={state.logoutPending()} onClick={() => void state.logout()}>
                        {state.logoutPending()
                          ? state.language.t("settings.account.loggingOut")
                          : state.language.t("settings.account.logout")}
                      </ButtonV2>
                    </SettingsRowV2>
                  )}
                </Show>
              </Show>
            </Show>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
