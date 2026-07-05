import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"

export function DialogWorkspaceUnavailable(props: { onRestore?: () => boolean | void | Promise<boolean | void> }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "restore" as "cancel" | "restore",
  })

  const options = ["cancel", "restore"] as const

  async function confirm() {
    if (store.active === "cancel") {
      dialog.clear()
      return
    }
    const result = await props.onRestore?.()
    if (result === false) return
  }

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Ажлын орчны сонголтыг батлах", group: "Dialog", cmd: () => void confirm() },
      { key: "left", desc: "Ажлын орчин сэргээхийг цуцлах", group: "Dialog", cmd: () => setStore("active", "cancel") },
      { key: "right", desc: "Ажлын орчин сэргээх", group: "Dialog", cmd: () => setStore("active", "restore") },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Ажлын орчин боломжгүй
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        Энэ сешн одоо боломжгүй болсон ажлын орчинд холбогдсон байна.
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Энэ сешнийг шинэ ажлын орчинд сэргээх үү?
      </text>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={item === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item)
                void confirm()
              }}
            >
              <text fg={item === store.active ? theme.selectedListItemText : theme.textMuted}>
                {item === "cancel" ? "цуцлах" : "сэргээх"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
