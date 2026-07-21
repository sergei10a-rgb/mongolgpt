import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { SessionStatus } from "@mongolgpt/sdk/v2"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useSessionLayout } from "./session-layout"
import { useDialog } from "@mongolgpt/ui/context"
import { DialogUsageExceeded } from "@/components/dialog-usage-exceeded"
import { useI18n } from "@mongolgpt/ui/context"

const USAGE_PROMPT_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const USAGE_PROMPT_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const USAGE_PROMPT_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const USAGE_PROMPT_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const USAGE_PROMPT_WINDOW = 86_400_000 // 24 hrs
const MANAGED_PROVIDERS = new Set(["mongolgpt", "mongolgpt-go"])

function usagePromptKeys(status: SessionStatus) {
  if (status.type !== "retry" || !status.action) return
  const { action } = status
  if (!MANAGED_PROVIDERS.has(action.provider)) return
  if (action.reason === "free_tier_limit") {
    return {
      lastSeenAt: USAGE_PROMPT_FREE_TIER_LAST_SEEN_AT,
      dontShow: USAGE_PROMPT_FREE_TIER_DONT_SHOW,
    } as const
  }
  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: USAGE_PROMPT_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: USAGE_PROMPT_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    } as const
  }
}

export function useUsageExceededDialogs() {
  const sdk = useSDK()
  const dialog = useDialog()
  const { params } = useSessionLayout()
  const { t, locale } = useI18n()
  const isMongolian = () => locale() === "mn"

  const [usagePromptState, setUsagePromptState] = persisted(
    Persist.global("usage-limit-prompt", ["go-upsell"]),
    createStore({
      [USAGE_PROMPT_FREE_TIER_LAST_SEEN_AT]: null as null | number,
      [USAGE_PROMPT_FREE_TIER_DONT_SHOW]: null as null | number,
      [USAGE_PROMPT_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT]: null as null | number,
      [USAGE_PROMPT_ACCOUNT_RATE_LIMIT_DONT_SHOW]: null as null | number,
    }),
  )

  onCleanup(
    sdk().event.on("session.status", (evt) => {
      if (evt.properties.sessionID !== params.id) return
      if (evt.properties.status.type !== "retry") return
      const { action } = evt.properties.status
      if (!action) return
      if (dialog.active) return

      const keys = usagePromptKeys(evt.properties.status)
      if (!keys) return

      const seen = usagePromptState[keys.lastSeenAt]
      if (seen && Date.now() - seen < USAGE_PROMPT_WINDOW) return
      if (usagePromptState[keys.dontShow]) return

      if (action.reason === "free_tier_limit") {
        dialog.show(() => (
          <DialogUsageExceeded
            title={isMongolian() ? action.title : t("dialog.usageExceeded.freeTier.title")}
            description={isMongolian() ? action.message : t("dialog.usageExceeded.freeTier.description")}
            actionLabel={isMongolian() ? action.label : t("dialog.usageExceeded.freeTier.actionLabel")}
            link={action.link}
            onClose={(dontShowAgain) => {
              setUsagePromptState(keys.lastSeenAt, Date.now())
              if (dontShowAgain) setUsagePromptState(keys.dontShow, Date.now())
            }}
          />
        ))
      } else if (action.reason === "account_rate_limit") {
        dialog.show(() => (
          <DialogUsageExceeded
            title={isMongolian() ? action.title : t("dialog.usageExceeded.accountRateLimit.title")}
            description={isMongolian() ? action.message : t("dialog.usageExceeded.accountRateLimit.description")}
            actionLabel={isMongolian() ? action.label : t("dialog.usageExceeded.accountRateLimit.actionLabel")}
            link={action.link}
            onClose={(dontShowAgain) => {
              setUsagePromptState(keys.lastSeenAt, Date.now())
              if (dontShowAgain) setUsagePromptState(keys.dontShow, Date.now())
            }}
          />
        ))
      }
    }),
  )
}
