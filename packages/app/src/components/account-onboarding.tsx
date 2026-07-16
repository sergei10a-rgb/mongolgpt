import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { Dialog } from "@mongolgpt/ui/dialog"
import { ProviderIcon } from "@mongolgpt/ui/provider-icon"
import { type Accessor, createEffect, Match, Show, Switch } from "solid-js"
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
  const platform = usePlatform()
  const server = useServer()
  const sync = useServerSync()
  const [state, setState, , storageReady] = persisted(
    Persist.global("account-onboarding.v1"),
    createStore({ completed: false }),
  )
  const [gate, setGate] = createStore({ shown: false })

  const connected = () => sync().data.provider.connected.includes("mongolgpt")
  const ready = () =>
    platform.platform === "desktop" &&
    ServerConnection.local(server.current) &&
    storageReady() &&
    sync().data.ready &&
    sync().data.provider.all.has("mongolgpt")

  createEffect(() => {
    const stage = accountOnboardingStage({ ready: ready(), connected: connected(), completed: state.completed })
    if (!stage || gate.shown) return
    setGate("shown", true)
    void dialog.show(
      () => (
        <DialogAccountOnboarding
          connected={connected}
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
  nvidiaAvailable: Accessor<boolean>
  onComplete: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ connected: false, nvidiaConnected: false })
  const connected = () => state.connected || props.connected()

  const login = () => {
    dialog.push(() => (
      <DialogConnectProvider provider="mongolgpt" back="close" onConnected={() => setState("connected", true)} />
    ))
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
              <Button class="self-start" size="large" variant="primary" onClick={login}>
                {language.t("onboarding.account.login")}
              </Button>
            </div>
          </Match>
          <Match when={connected()}>
            <div class="px-2.5 pb-6 flex flex-col gap-5">
              <div class="flex flex-col gap-1">
                <div class="text-16-medium text-text-strong">{language.t("onboarding.providers.heading")}</div>
                <p class="text-14-regular text-text-base">{language.t("onboarding.providers.description")}</p>
              </div>

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
