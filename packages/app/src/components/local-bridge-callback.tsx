import { createEffect } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import {
  createBrowserLocalBridgeClient,
  isLocalBridgeCallback,
  type LocalBridgeConnection,
} from "@/utils/local-bridge-client"
import { showToast } from "@/utils/toast"

type LocalBridgeCallbackInput = {
  currentURL: string
  exchange: (url: string) => Promise<LocalBridgeConnection>
  currentAccountID: () => Promise<string | undefined>
  addEphemeral: (
    connection: {
      type: "http"
      displayName: string
      http: { url: string; username: string; password: string }
    },
    expiresAt: number,
  ) => unknown
  name: string
  accountMismatch: string
  expired: string
}

export async function connectLocalBridgeCallback(input: LocalBridgeCallbackInput) {
  const connection = await input.exchange(input.currentURL)
  if ((await input.currentAccountID()) !== connection.accountID) throw new Error(input.accountMismatch)
  const added = input.addEphemeral(
    {
      type: "http",
      displayName: input.name,
      http: {
        url: connection.url,
        username: connection.username,
        password: connection.password,
      },
    },
    connection.expiresAt,
  )
  if (!added) throw new Error(input.expired)
  return connection
}

export function LocalBridgeCallback() {
  const platform = usePlatform()
  const server = useServer()
  const language = useLanguage()
  let handled = false

  createEffect(() => {
    if (handled || platform.platform !== "web") return
    if (!isLocalBridgeCallback(window.location.href, window.location.origin)) return
    handled = true

    void (async () => {
      try {
        await connectLocalBridgeCallback({
          currentURL: window.location.href,
          exchange: createBrowserLocalBridgeClient().callback,
          currentAccountID: async () => (await platform.account?.current())?.id,
          addEphemeral: server.addEphemeral,
          name: language.t("dialog.server.bridge.name"),
          accountMismatch: language.t("dialog.server.bridge.accountMismatch"),
          expired: language.t("dialog.server.bridge.expired"),
        })
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("dialog.server.bridge.connected.title"),
          description: language.t("dialog.server.bridge.connected.description"),
        })
      } catch (error) {
        showToast({
          variant: "error",
          title: language.t("dialog.server.bridge.failed.title"),
          description: error instanceof Error ? error.message : language.t("dialog.server.bridge.failed.description"),
        })
      }
    })()
  })

  return null
}
