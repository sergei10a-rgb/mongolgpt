import { usePlatform } from "@/context/platform"
import { Button } from "@mongolgpt/ui/button"
import { useDialog } from "@mongolgpt/ui/context/dialog"
import { useI18n } from "@mongolgpt/ui/context"
import { Dialog } from "@mongolgpt/ui/dialog"
import { JSX } from "solid-js"

export type DialogUsageExceededProps = {
  title: string
  description: JSX.Element
  link?: string
  actionLabel: string
  onClose?: (dontShowAgain?: boolean) => void
}

export function DialogUsageExceeded(props: DialogUsageExceededProps) {
  const dialog = useDialog()
  const platform = usePlatform()
  const { t } = useI18n()

  const runAction = () => {
    if (props.link) platform.openLink(props.link)
    props.onClose?.()
    dialog.close()
  }

  const dismiss = () => {
    props.onClose?.(true)
    dialog.close()
  }

  return (
    <Dialog title={props.title} description={props.description} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={dismiss}>
            {t("dialog.usageExceeded.dismiss")}
          </Button>
          <Button variant="primary" size="large" onClick={runAction}>
            {props.actionLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
