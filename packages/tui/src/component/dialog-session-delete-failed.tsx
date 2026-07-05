import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useBindings } from "../keymap"

export function DialogSessionDeleteFailed(props: {
  session: string
  workspace: string
  onDelete?: () => boolean | void | Promise<boolean | void>
  onRestore?: () => boolean | void | Promise<boolean | void>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "delete" as "delete" | "restore",
  })

  const options = [
    {
      id: "delete" as const,
      title: "Ажлын орчин устгах",
      description: "Ажлын орчин болон түүнд холбоотой бүх сешнийг устгана.",
      run: props.onDelete,
    },
    {
      id: "restore" as const,
      title: "Шинэ ажлын орчин руу сэргээх",
      description: "Энэ сешнийг шинэ ажлын орчинд сэргээхийг оролдоно.",
      run: props.onRestore,
    },
  ]

  async function confirm() {
    const result = await options.find((item) => item.id === store.active)?.run?.()
    if (result === false) return
    props.onDone?.()
    if (!props.onDone) dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Сэргээх сонголтыг батлах", group: "Dialog", cmd: () => void confirm() },
      { key: "left", desc: "Эвдэрсэн сешнийг устгах", group: "Dialog", cmd: () => setStore("active", "delete") },
      { key: "up", desc: "Эвдэрсэн сешнийг устгах", group: "Dialog", cmd: () => setStore("active", "delete") },
      { key: "right", desc: "Эвдэрсэн сешнийг сэргээх", group: "Dialog", cmd: () => setStore("active", "restore") },
      { key: "down", desc: "Эвдэрсэн сешнийг сэргээх", group: "Dialog", cmd: () => setStore("active", "restore") },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Сешн устгаж чадсангүй
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {`"${props.workspace}" ажлын орчин боломжгүй байгаа тул "${props.session}" сешнийг устгаж чадсангүй.`}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Энэ эвдэрсэн ажлын орчны сешнийг яаж сэргээхээ сонгоно уу.
      </text>
      <box flexDirection="column" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={item.id === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item.id)
                void confirm()
              }}
            >
              <text
                attributes={TextAttributes.BOLD}
                fg={item.id === store.active ? theme.selectedListItemText : theme.text}
              >
                {item.title}
              </text>
              <text fg={item.id === store.active ? theme.selectedListItemText : theme.textMuted} wrapMode="word">
                {item.description}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
