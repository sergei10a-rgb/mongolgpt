import { Button } from "@mongolgpt/ui/button"
import { ProviderIcon } from "@mongolgpt/ui/provider-icon"
import { ButtonV2 } from "@mongolgpt/ui/v2/button-v2"
import type { AccountOverview } from "@mongolgpt/account-contract"
import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
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

type AccountWorkspace = AccountOverview["workspaces"][number]

const PLAN_KEYS = {
  free: "settings.account.plan.free",
  basic: "settings.account.plan.basic",
  pro: "settings.account.plan.pro",
  max: "settings.account.plan.max",
} as const

const ROLE_KEYS = {
  admin: "settings.account.role.admin",
  member: "settings.account.role.member",
} as const

const PERIOD_KEYS = {
  week: "settings.account.period.week",
  subscription: "settings.account.period.subscription",
} as const

export function formatAccountNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value)
}

export function formatAccountPercent(used: number, limit: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(used / limit)
}

export function formatAccountDate(value: number, locale: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

export function accountOverviewForAccount(accountID: string, overview: AccountOverview) {
  if (overview.account.id !== accountID) throw new Error("Аккаунтын мэдээлэл зөрүүтэй байна")
  return overview
}

export function accountWorkspaceView(overview: AccountOverview, workspace: AccountWorkspace) {
  const limit =
    workspace.limits.plan === "free"
      ? {
          kind: "free" as const,
          dailyRequests: workspace.limits.dailyRequests,
          dailyRequestsFallback: workspace.limits.dailyRequestsFallback,
        }
      : {
          kind: "paid" as const,
          weeklyTokenLimit: workspace.limits.weeklyTokenLimit,
          weeklyRequestLimit: workspace.limits.weeklyRequestLimit,
          monthlyTokenLimit: workspace.limits.monthlyTokenLimit,
          monthlyRequestLimit: workspace.limits.monthlyRequestLimit,
          rollingWindowHours: workspace.limits.rollingWindowHours,
        }

  const quota =
    workspace.quota.status === "available"
      ? {
          kind: "available" as const,
          weeklyTokens: workspace.quota.weeklyTokens,
          weeklyCost: workspace.quota.weeklyCost,
          weeklyRequests: workspace.quota.weeklyRequests,
          monthlyCost: workspace.quota.monthlyCost,
          monthlyTokens: workspace.quota.monthlyTokens,
          monthlyRequests: workspace.quota.monthlyRequests,
          rollingCost: workspace.quota.rollingCost,
        }
      : workspace.quota.status === "model-scoped"
        ? { kind: "model-scoped" as const }
        : { kind: "unavailable" as const }

  return {
    current: workspace.id === overview.currentWorkspaceID,
    plan: workspace.limits.plan,
    role: workspace.role,
    period: workspace.usage.period,
    requestCount: workspace.usage.requestCount,
    totalTokens: workspace.usage.totalTokens,
    limit,
    quota,
  }
}

function useSettingsAccount() {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const [pending, setPending] = createSignal<"login" | "logout" | "retry" | "overview-retry">()
  const [operationError, setOperationError] = createSignal(false)
  const [workspaceState, setWorkspaceState] = createStore({ pending: "", error: false })
  const [account, actions] = createResource(
    () => platform.account,
    (api) => api.current(),
  )
  const [overview, overviewActions] = createResource(
    () => {
      const api = platform.account
      const current = account()
      if (!api || !current) return
      return { api, accountID: current.id }
    },
    async ({ api, accountID }) => accountOverviewForAccount(accountID, await api.overview()),
  )

  const refreshProviders = () =>
    serverSync()
      .refreshGlobal()
      .catch(() => undefined)
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
      overviewActions.mutate(undefined)
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
  const retryOverview = async () => {
    setPending("overview-retry")
    try {
      await overviewActions.refetch()
    } catch {
      // The resource exposes the error state below.
    } finally {
      setPending()
    }
  }
  const switchWorkspace = async (workspaceID: string) => {
    const api = platform.account
    if (!api?.switchWorkspace) return
    setWorkspaceState({ pending: workspaceID, error: false })
    try {
      const current = await api.switchWorkspace(workspaceID)
      actions.mutate(current)
      overviewActions.mutate(accountOverviewForAccount(current.id, await api.overview(workspaceID)))
      await refreshProviders()
    } catch {
      setWorkspaceState("error", true)
    } finally {
      setWorkspaceState("pending", "")
    }
  }

  return {
    account,
    overview,
    error: () => operationError() || account.error !== undefined,
    loading: () => account.loading || pending() === "retry",
    overviewError: () => overview.error !== undefined,
    overviewLoading: () => overview.loading || pending() === "overview-retry",
    login,
    logout,
    retry,
    retryOverview,
    switchWorkspace,
    canSwitchWorkspace: () => platform.account?.switchWorkspace !== undefined,
    workspaceSwitchError: () => workspaceState.error,
    workspaceSwitchPending: (workspaceID: string) => workspaceState.pending === workspaceID,
    workspaceSwitching: () => workspaceState.pending !== "",
    loginPending: () => pending() === "login",
    logoutPending: () => pending() === "logout",
    language,
  }
}

type SettingsAccountState = ReturnType<typeof useSettingsAccount>

function WorkspaceTitle(props: { name: string; current: boolean }) {
  const language = useLanguage()
  return (
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span class="text-14-medium text-text-strong break-words">{props.name}</span>
      <Show when={props.current}>
        <span class="text-12-medium text-text-weak">{language.t("settings.account.currentWorkspace")}</span>
      </Show>
    </div>
  )
}

function WorkspaceDetails(props: { overview: AccountOverview; workspace: AccountWorkspace }) {
  const language = useLanguage()
  const view = createMemo(() => accountWorkspaceView(props.overview, props.workspace))
  const number = (value: number) => formatAccountNumber(value, language.intl())
  const percent = (used: number, limit: number) => formatAccountPercent(used, limit, language.intl())
  const limit = createMemo(() => {
    const value = view().limit
    if (value.kind === "free") {
      return language.t("settings.account.limit.free", {
        primary: number(value.dailyRequests),
        fallback: number(value.dailyRequestsFallback),
      })
    }
    return language.t("settings.account.limit.paid", {
      weeklyTokens: number(value.weeklyTokenLimit),
      weeklyRequests: number(value.weeklyRequestLimit),
      monthlyTokens: number(value.monthlyTokenLimit),
      monthlyRequests: number(value.monthlyRequestLimit),
    })
  })
  const quota = createMemo(() => {
    const value = view().quota
    if (value.kind === "available") {
      return language.t("settings.account.quota.available", {
        used: number(value.weeklyTokens.used),
        limit: number(value.weeklyTokens.limit),
      })
    }
    if (value.kind === "model-scoped") return language.t("settings.account.quota.modelScoped")
    return language.t("settings.account.quota.unavailable")
  })
  const resetAt = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available" || value.weeklyTokens.resetAt === null) return ""
    return formatAccountDate(value.weeklyTokens.resetAt, language.intl())
  })
  const monthlyResetAt = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available" || value.monthlyTokens.resetAt === null) return ""
    return formatAccountDate(value.monthlyTokens.resetAt, language.intl())
  })
  const weeklyCost = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available") return ""
    return language.t("settings.account.quota.weeklyCost", {
      percent: percent(value.weeklyCost.used, value.weeklyCost.limit),
    })
  })
  const weeklyRequests = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available") return ""
    return language.t("settings.account.quota.weeklyRequests", {
      used: number(value.weeklyRequests.used),
      limit: number(value.weeklyRequests.limit),
    })
  })
  const monthlyTokens = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available") return ""
    return language.t("settings.account.quota.monthlyTokens", {
      used: number(value.monthlyTokens.used),
      limit: number(value.monthlyTokens.limit),
    })
  })
  const monthlyRequests = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available") return ""
    return language.t("settings.account.quota.monthlyRequests", {
      used: number(value.monthlyRequests.used),
      limit: number(value.monthlyRequests.limit),
    })
  })
  const monthlyCost = createMemo(() => {
    const value = view().quota
    if (value.kind !== "available") return ""
    return language.t("settings.account.quota.monthlyCost", {
      percent: percent(value.monthlyCost.used, value.monthlyCost.limit),
    })
  })
  const rollingCost = createMemo(() => {
    const value = view()
    if (value.quota.kind !== "available" || value.limit.kind !== "paid") return ""
    return language.t("settings.account.quota.rollingCost", {
      hours: number(value.limit.rollingWindowHours),
      percent: percent(value.quota.rollingCost.used, value.quota.rollingCost.limit),
    })
  })

  return (
    <div class="flex min-w-0 flex-col gap-1 text-12-regular text-text-weak">
      <span>
        {language.t("settings.account.workspaceMeta", {
          role: language.t(ROLE_KEYS[view().role]),
          period: language.t(PERIOD_KEYS[view().period]),
        })}
      </span>
      <span>
        {language.t("settings.account.usage", {
          requests: number(view().requestCount),
          tokens: number(view().totalTokens),
        })}
      </span>
      <span>{limit()}</span>
      <span>{quota()}</span>
      <Show when={weeklyCost()} keyed>
        {(value) => <span>{value}</span>}
      </Show>
      <Show when={weeklyRequests()} keyed>
        {(value) => <span>{value}</span>}
      </Show>
      <Show when={monthlyTokens()} keyed>
        {(value) => <span>{value}</span>}
      </Show>
      <Show when={monthlyRequests()} keyed>
        {(value) => <span>{value}</span>}
      </Show>
      <Show when={monthlyCost()} keyed>
        {(value) => <span>{value}</span>}
      </Show>
      <Show when={rollingCost()} keyed>
        {(value) => <span>{value}</span>}
      </Show>
      <Show when={resetAt()} keyed>
        {(value) => <span>{language.t("settings.account.quota.resetAt", { date: value })}</span>}
      </Show>
      <Show when={monthlyResetAt()} keyed>
        {(value) => <span>{language.t("settings.account.quota.monthlyResetAt", { date: value })}</span>}
      </Show>
    </div>
  )
}

function WorkspacePlan(props: { plan: AccountWorkspace["limits"]["plan"] }) {
  const language = useLanguage()
  return <span class="shrink-0 text-12-medium text-text-strong">{language.t(PLAN_KEYS[props.plan])}</span>
}

function WorkspaceActionsV1(props: { state: SettingsAccountState; workspace: AccountWorkspace; current: boolean }) {
  return (
    <div class="flex shrink-0 items-center gap-2">
      <WorkspacePlan plan={props.workspace.limits.plan} />
      <Show when={!props.current && props.state.canSwitchWorkspace()}>
        <Button
          size="normal"
          variant="secondary"
          disabled={props.state.workspaceSwitching()}
          onClick={() => void props.state.switchWorkspace(props.workspace.id)}
        >
          {props.state.workspaceSwitchPending(props.workspace.id)
            ? props.state.language.t("settings.account.workspaceSwitching")
            : props.state.language.t("settings.account.workspaceSwitch")}
        </Button>
      </Show>
    </div>
  )
}

function WorkspaceActionsV2(props: { state: SettingsAccountState; workspace: AccountWorkspace; current: boolean }) {
  return (
    <div class="flex shrink-0 items-center gap-2">
      <WorkspacePlan plan={props.workspace.limits.plan} />
      <Show when={!props.current && props.state.canSwitchWorkspace()}>
        <ButtonV2
          variant="neutral"
          disabled={props.state.workspaceSwitching()}
          onClick={() => void props.state.switchWorkspace(props.workspace.id)}
        >
          {props.state.workspaceSwitchPending(props.workspace.id)
            ? props.state.language.t("settings.account.workspaceSwitching")
            : props.state.language.t("settings.account.workspaceSwitch")}
        </ButtonV2>
      </Show>
    </div>
  )
}

function AccountOverviewV1(props: { state: SettingsAccountState }) {
  return (
    <div class="mt-6 flex flex-col gap-1 max-w-[720px]">
      <h3 class="pb-2 text-14-medium text-text-strong">{props.state.language.t("settings.account.overview")}</h3>
      <Show when={props.state.workspaceSwitchError()}>
        <p class="pb-2 text-13-regular text-icon-critical-base" role="alert">
          {props.state.language.t("settings.account.workspaceSwitchError")}
        </p>
      </Show>
      <SettingsList>
        <Show
          when={!props.state.overviewLoading()}
          fallback={
            <div class="py-5 text-14-regular text-text-weak" role="status" aria-live="polite">
              {props.state.language.t("settings.account.overviewLoading")}
            </div>
          }
        >
          <Show
            when={!props.state.overviewError()}
            fallback={
              <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
                <div class="flex min-w-0 flex-col gap-1">
                  <span class="text-14-medium text-icon-critical-base" role="alert">
                    {props.state.language.t("settings.account.overviewLoadError")}
                  </span>
                  <span class="text-12-regular text-text-weak">
                    {props.state.language.t("settings.account.overviewLoadErrorDescription")}
                  </span>
                </div>
                <Button
                  size="large"
                  variant="secondary"
                  disabled={props.state.overviewLoading()}
                  onClick={() => void props.state.retryOverview()}
                >
                  {props.state.language.t("settings.account.retry")}
                </Button>
              </div>
            }
          >
            <Show
              when={props.state.overview()}
              keyed
              fallback={
                <div class="py-5 text-14-regular text-text-weak" role="status" aria-live="polite">
                  {props.state.language.t("settings.account.overviewLoading")}
                </div>
              }
            >
              {(value) => (
                <Show
                  when={value.workspaces.length > 0}
                  fallback={
                    <div class="flex min-h-16 flex-col justify-center gap-1 py-3">
                      <span class="text-14-medium text-text-strong">
                        {props.state.language.t("settings.account.noWorkspaces")}
                      </span>
                      <span class="text-12-regular text-text-weak">
                        {props.state.language.t("settings.account.noWorkspacesDescription")}
                      </span>
                    </div>
                  }
                >
                  <For each={value.workspaces}>
                    {(workspace) => {
                      const view = accountWorkspaceView(value, workspace)
                      return (
                        <div class="flex min-h-24 flex-wrap items-start justify-between gap-4 border-b border-border-weak-base py-3 last:border-none sm:flex-nowrap">
                          <div class="flex min-w-0 flex-col gap-1">
                            <WorkspaceTitle name={workspace.name} current={view.current} />
                            <WorkspaceDetails overview={value} workspace={workspace} />
                          </div>
                          <WorkspaceActionsV1 state={props.state} workspace={workspace} current={view.current} />
                        </div>
                      )
                    }}
                  </For>
                </Show>
              )}
            </Show>
          </Show>
        </Show>
      </SettingsList>
    </div>
  )
}

function AccountOverviewV2(props: { state: SettingsAccountState }) {
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{props.state.language.t("settings.account.overview")}</h3>
      <Show when={props.state.workspaceSwitchError()}>
        <p class="text-13-regular text-icon-critical-base" role="alert">
          {props.state.language.t("settings.account.workspaceSwitchError")}
        </p>
      </Show>
      <SettingsListV2>
        <Show
          when={!props.state.overviewLoading()}
          fallback={
            <SettingsRowV2
              title={
                <span role="status" aria-live="polite">
                  {props.state.language.t("settings.account.overviewLoading")}
                </span>
              }
              description={props.state.language.t("settings.account.overviewLoadingDescription")}
            >
              <span />
            </SettingsRowV2>
          }
        >
          <Show
            when={!props.state.overviewError()}
            fallback={
              <SettingsRowV2
                title={<span role="alert">{props.state.language.t("settings.account.overviewLoadError")}</span>}
                description={props.state.language.t("settings.account.overviewLoadErrorDescription")}
              >
                <ButtonV2
                  variant="neutral"
                  disabled={props.state.overviewLoading()}
                  onClick={() => void props.state.retryOverview()}
                >
                  {props.state.language.t("settings.account.retry")}
                </ButtonV2>
              </SettingsRowV2>
            }
          >
            <Show
              when={props.state.overview()}
              keyed
              fallback={
                <SettingsRowV2
                  title={
                    <span role="status" aria-live="polite">
                      {props.state.language.t("settings.account.overviewLoading")}
                    </span>
                  }
                  description={props.state.language.t("settings.account.overviewLoadingDescription")}
                >
                  <span />
                </SettingsRowV2>
              }
            >
              {(value) => (
                <Show
                  when={value.workspaces.length > 0}
                  fallback={
                    <SettingsRowV2
                      title={props.state.language.t("settings.account.noWorkspaces")}
                      description={props.state.language.t("settings.account.noWorkspacesDescription")}
                    >
                      <span />
                    </SettingsRowV2>
                  }
                >
                  <For each={value.workspaces}>
                    {(workspace) => {
                      const view = accountWorkspaceView(value, workspace)
                      return (
                        <SettingsRowV2
                          title={<WorkspaceTitle name={workspace.name} current={view.current} />}
                          description={<WorkspaceDetails overview={value} workspace={workspace} />}
                        >
                          <WorkspaceActionsV2 state={props.state} workspace={workspace} current={view.current} />
                        </SettingsRowV2>
                      )
                    }}
                  </For>
                </Show>
              )}
            </Show>
          </Show>
        </Show>
      </SettingsListV2>
    </div>
  )
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
            fallback={
              <div class="py-5 text-14-regular text-text-weak" role="status" aria-live="polite">
                {state.language.t("settings.account.loading")}
              </div>
            }
          >
            <Show
              when={!state.error()}
              fallback={
                <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
                  <span class="text-14-regular text-icon-critical-base" role="alert">
                    {state.language.t("settings.account.loadError")}
                  </span>
                  <Button
                    size="large"
                    variant="secondary"
                    disabled={state.loading()}
                    onClick={() => void state.retry()}
                  >
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
                      <span class="text-14-medium text-text-strong">
                        {state.language.t("settings.account.signedOut")}
                      </span>
                      <span class="text-12-regular text-text-weak">
                        {state.language.t("settings.account.signedOutDescription")}
                      </span>
                    </div>
                    <Button
                      size="large"
                      variant="primary"
                      disabled={state.loginPending()}
                      onClick={() => void state.login()}
                    >
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
                    <Button
                      size="large"
                      variant="secondary"
                      disabled={state.logoutPending()}
                      onClick={() => void state.logout()}
                    >
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
      <Show when={state.account() && !state.error()}>
        <AccountOverviewV1 state={state} />
      </Show>
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
                  title={
                    <span role="status" aria-live="polite">
                      {state.language.t("settings.account.loading")}
                    </span>
                  }
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
                    title={<span role="alert">{state.language.t("settings.account.loadError")}</span>}
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
        <Show when={state.account() && !state.error()}>
          <AccountOverviewV2 state={state} />
        </Show>
      </div>
    </>
  )
}
