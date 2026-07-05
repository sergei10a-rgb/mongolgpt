import { createStore } from "solid-js/store"
import { dirname } from "node:path"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useTheme, selectedForeground } from "../../context/theme"
import type { PermissionRequest } from "@mongolgpt/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../ui/border"
import { useSync } from "../../context/sync"
import { useProject } from "../../context/project"
import { filetype } from "../../util/filetype"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../config"
import { MONGOLGPT_BASE_MODE, useBindings, useCommandShortcut } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"

type PermissionStage = "permission" | "always" | "reject"

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => {
    const value = props.request.metadata?.filepath
    return typeof value === "string" ? value : ""
  })
  const diff = createMemo(() => {
    const value = props.request.metadata?.diff
    return typeof value === "string" ? value : ""
  })

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </scrollbox>
      </Show>
      <Show when={!diff()}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>Diff өгөгдсөнгүй</text>
        </box>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest; directory?: string }) {
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })
  const pathFormatter = usePathFormatter()

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Үргэлж зөвшөөрөх"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={props.request.permission + "-г MongolGPT дахин эхлэх хүртэл зөвшөөрнө."} />
              </Match>
              <Match when={true}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.textMuted}>Дараах pattern-уудыг MongolGPT дахин эхлэх хүртэл зөвшөөрнө</text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.text}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "Батлах", cancel: "Цуцлах" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            void sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
              directory: props.directory,
              workspace: project.workspace.current(),
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            void sdk.client.permission.reply({
              reply: "reject",
              requestID: props.request.id,
              directory: props.directory,
              message: message || undefined,
              workspace: project.workspace.current(),
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const info = () => {
            const permission = props.request.permission
            const data = input()

            if (permission === "edit") {
              const raw = props.request.metadata?.filepath
              const filepath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `${pathFormatter.format(filepath)} засах`,
                body: <EditBody request={props.request} />,
              }
            }

            if (permission === "read") {
              const raw = data.filePath
              const filePath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `${pathFormatter.format(filePath)} унших`,
                body: (
                  <Show when={filePath}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Зам: " + pathFormatter.format(filePath)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "glob") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Glob "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "grep") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Grep "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "list") {
              const raw = data.path
              const dir = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `${pathFormatter.format(dir)} жагсаах`,
                body: (
                  <Show when={dir}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Зам: " + pathFormatter.format(dir)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "bash") {
              const command = typeof data.command === "string" ? data.command : ""
              return {
                icon: "#",
                title: "Shell команд",
                body: (
                  <Show when={command}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"$ " + command}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "task") {
              const type = typeof data.subagent_type === "string" ? data.subagent_type : "Тодорхойгүй"
              const desc = typeof data.description === "string" ? data.description : ""
              return {
                icon: "#",
                title: `${Locale.titlecase(type)} task`,
                body: (
                  <Show when={desc}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"◉ " + desc}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "webfetch") {
              const url = typeof data.url === "string" ? data.url : ""
              return {
                icon: "%",
                title: `WebFetch ${url}`,
                body: (
                  <Show when={url}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"URL: " + url}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "websearch") {
              const query = typeof data.query === "string" ? data.query : ""
              return {
                icon: "◈",
                title: `${webSearchProviderLabel(data.provider)} "${query}"`,
                body: (
                  <Show when={query}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Query: " + query}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "external_directory") {
              const meta = props.request.metadata ?? {}
              const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
              const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
              const pattern = props.request.patterns?.[0]
              const derived =
                typeof pattern === "string" ? (pattern.includes("*") ? dirname(pattern) : pattern) : undefined

              const raw = parent ?? filepath ?? derived
              const dir = pathFormatter.format(raw)
              const patterns = (props.request.patterns ?? []).filter((p): p is string => typeof p === "string")

              return {
                icon: "←",
                title: `Гадаад хавтаст хандах ${dir}`,
                body: (
                  <Show when={patterns.length > 0}>
                    <box paddingLeft={1} gap={1}>
                      <text fg={theme.textMuted}>Pattern-ууд</text>
                      <box>
                        <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
                      </box>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "doom_loop") {
              return {
                icon: "⟳",
                title: "Давтагдсан алдааны дараа үргэлжлүүлэх",
                body: (
                  <box paddingLeft={1}>
                    <text fg={theme.textMuted}>Давтагдсан алдаа гарсан ч сешнийг үргэлжлүүлнэ.</text>
                  </box>
                ),
              }
            }

            return {
              icon: "⚙",
              title: `${permission} tool дуудах`,
              body: (
                <box paddingLeft={1}>
                  <text fg={theme.textMuted}>{"Tool: " + permission}</text>
                </box>
              ),
            }
          }

          const current = info()

          const header = () => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.warning}>{"△"}</text>
                <text fg={theme.text}>Зөвшөөрөл шаардлагатай</text>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                <text fg={theme.textMuted} flexShrink={0}>
                  {current.icon}
                </text>
                <text fg={theme.text}>{current.title}</text>
              </box>
            </box>
          )

          const body = (
            <Prompt
              title="Зөвшөөрөл шаардлагатай"
              header={header()}
              body={current.body}
              options={{ once: "Нэг удаа зөвшөөрөх", always: "Үргэлж зөвшөөрөх", reject: "Татгалзах" }}
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  void sdk.client.permission.reply({
                    reply: "reject",
                    requestID: props.request.id,
                    directory: props.directory,
                    workspace: project.workspace.current(),
                  })
                  return
                }
                void sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                  directory: props.directory,
                  workspace: project.workspace.current(),
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  useBindings(() => ({
    mode: MONGOLGPT_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: "Зөвшөөрөл татгалзахыг цуцлах",
        category: "Зөвшөөрөл",
        run() {
          props.onCancel()
        },
      },
    ],
    bindings: [
      { key: "escape", desc: "Зөвшөөрөл татгалзахыг цуцлах", group: "Permission", cmd: () => props.onCancel() },
      ...tuiConfig.keybinds.get("app.exit"),
      {
        key: "return",
        desc: "Зөвшөөрөл татгалзахыг батлах",
        group: "Permission",
        cmd: () => props.onConfirm(input.plainText),
      },
    ],
  }))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>Зөвшөөрөл татгалзах</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>MongolGPT юуг өөрөөр хийх ёстойг бичнэ үү</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => {
            input = val
            val.traits = { status: "REJECT" }
          }}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>батлах</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>цуцлах</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  header?: JSX.Element
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const narrow = createMemo(() => dimensions().width < 80)
  const fullscreenHint = useCommandShortcut("permission.prompt.fullscreen")

  useBindings(() => ({
    mode: MONGOLGPT_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: "Зөвшөөрөл татгалзах",
        category: "Зөвшөөрөл",
        run() {
          if (!props.escapeKey) return
          props.onSelect(props.escapeKey)
        },
      },
      {
        name: "permission.prompt.fullscreen",
        title: "Зөвшөөрлийн fullscreen горимыг асаах/унтраах",
        category: "Зөвшөөрөл",
        run() {
          if (!props.fullscreen) return
          setStore("expanded", (v) => !v)
        },
      },
    ],
    bindings: [
      {
        key: "left",
        desc: "Өмнөх зөвшөөрлийн сонголт",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx - 1 + keys.length) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "h",
        desc: "Өмнөх зөвшөөрлийн сонголт",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx - 1 + keys.length) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "right",
        desc: "Дараагийн зөвшөөрлийн сонголт",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx + 1) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "l",
        desc: "Дараагийн зөвшөөрлийн сонголт",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx + 1) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "return",
        desc: "Зөвшөөрлийн сонголт сонгох",
        group: "Permission",
        cmd: () => props.onSelect(store.selected),
      },
      ...(props.escapeKey
        ? [
            {
              key: "escape",
              desc: "Зөвшөөрөл татгалзах",
              group: "Permission",
              cmd: () => props.onSelect(props.escapeKey!),
            },
          ]
        : []),
      ...(props.escapeKey ? tuiConfig.keybinds.get("app.exit") : []),
      ...(props.fullscreen ? tuiConfig.keybinds.get("permission.prompt.fullscreen") : []),
    ],
  }))

  const hint = createMemo(() => (store.expanded ? "жижигрүүлэх" : "fullscreen"))
  useRenderer()

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={theme.warning}>{"△"}</text>
              <text fg={theme.text}>{props.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {props.header}
          </box>
        </Show>
        {props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {fullscreenHint()} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"⇆"} <span style={{ fg: theme.textMuted }}>сонгох</span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>батлах</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
