import { ButtonV2 } from "@mongolgpt/ui/v2/button-v2"
import { SelectV2 } from "@mongolgpt/ui/v2/select-v2"
import { Switch } from "@mongolgpt/ui/v2/switch-v2"
import { Tag } from "@mongolgpt/ui/v2/badge-v2"
import { TextareaV2 } from "@mongolgpt/ui/v2/textarea-v2"
import { TextInputV2 } from "@mongolgpt/ui/v2/text-input-v2"
import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  requestCompatImport,
  type CompatImportPayload,
  type CompatImportResponse,
  type CompatImportScope,
  type CompatImportType,
  type CompatOperation,
  type CompatPatchOutcome,
} from "@/utils/compat-import"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type Option<T extends string> = {
  value: T
  label: string
  description: string
}

const TYPE_OPTIONS: Option<CompatImportType>[] = [
  { value: "auto", label: "Автоматаар", description: "MCP, skill, plugin аль нь болохыг MongolGPT өөрөө танина" },
  { value: "mcp", label: "MCP", description: "Claude, Cursor, Codex, Goose зэрэг MCP сервер" },
  { value: "skill", label: "Skill", description: "SKILL.md, skill хавтас, эсвэл skill URL" },
  { value: "plugin", label: "Plugin", description: "JS/TS plugin package эсвэл локал plugin хавтас" },
]

const SCOPE_OPTIONS: Option<CompatImportScope>[] = [
  { value: "global", label: "Бүх төсөл", description: "MongolGPT account/local global config дээр нэмнэ" },
  { value: "project", label: "Одоогийн төсөл", description: "Сонгосон project-ийн .mongolgpt config дээр нэмнэ" },
]

function parseLines(value: string) {
  const entries = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return entries.length > 0 ? entries : undefined
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function operationTitle(operation: CompatOperation) {
  switch (operation.kind) {
    case "mcp":
      return `MCP: ${operation.name ?? "server"}`
    case "skill-path":
      return "Skill path"
    case "skill-url":
      return "Skill URL"
    case "plugin": {
      const spec = Array.isArray(operation.spec) ? operation.spec[0] : operation.spec
      return `Plugin: ${spec ?? operation.source}`
    }
  }
}

function operationDetail(operation: CompatOperation) {
  if (operation.kind === "mcp") {
    if (operation.config?.type === "remote") return operation.config.url ?? operation.source
    return operation.config?.command?.join(" ") ?? operation.source
  }
  if (operation.kind === "skill-path" || operation.kind === "skill-url") return operation.value ?? operation.source
  if (operation.adapter) return `${operation.adapter.original} -> ${operation.adapter.file}`
  const spec = Array.isArray(operation.spec) ? operation.spec[0] : operation.spec
  return spec ?? operation.source
}

function outcomeLabel(outcome: CompatPatchOutcome) {
  if (outcome.mode === "add") return "Нэмнэ"
  if (outcome.mode === "replace") return "Солих"
  return "Өөрчлөхгүй"
}

function buildPayload(input: {
  type: CompatImportType
  scope: CompatImportScope
  source: string
  name: string
  env: string
  header: string
  force: boolean
  adapter: boolean
}): CompatImportPayload {
  return {
    type: input.type,
    scope: input.scope,
    source: input.source.trim() || undefined,
    name: input.name.trim() || undefined,
    env: parseLines(input.env),
    header: parseLines(input.header),
    force: input.force || undefined,
    adapter: input.adapter,
  }
}

export const SettingsImportsV2: Component = () => {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const [type, setType] = createSignal<CompatImportType>("auto")
  const [scope, setScope] = createSignal<CompatImportScope>("global")
  const [source, setSource] = createSignal("")
  const [name, setName] = createSignal("")
  const [env, setEnv] = createSignal("")
  const [header, setHeader] = createSignal("")
  const [force, setForce] = createSignal(false)
  const [adapter, setAdapter] = createSignal(true)
  const [projectDirectory, setProjectDirectory] = createSignal("")
  const [busy, setBusy] = createSignal<"plan" | "apply" | undefined>()
  const [response, setResponse] = createSignal<CompatImportResponse>()
  const [planKey, setPlanKey] = createSignal<string>()
  const [error, setError] = createSignal<string>()

  const defaultDirectory = createMemo(() => serverSync().data.path.directory || serverSync().data.path.worktree || "")
  const selectedDirectory = createMemo(() => projectDirectory().trim() || defaultDirectory())
  const selectedType = createMemo(() => TYPE_OPTIONS.find((item) => item.value === type()) ?? TYPE_OPTIONS[0])
  const selectedScope = createMemo(() => SCOPE_OPTIONS.find((item) => item.value === scope()) ?? SCOPE_OPTIONS[0])
  const payload = createMemo(() =>
    buildPayload({
      type: type(),
      scope: scope(),
      source: source(),
      name: name(),
      env: env(),
      header: header(),
      force: force(),
      adapter: adapter(),
    }),
  )
  const canRun = createMemo(() => !!source().trim() && !busy())
  const currentPlanKey = createMemo(() =>
    JSON.stringify({
      payload: payload(),
      directory: scope() === "project" ? selectedDirectory() : undefined,
    }),
  )
  const canApply = createMemo(() => canRun() && !!response() && planKey() === currentPlanKey())

  const run = async (mode: "plan" | "apply") => {
    setError(undefined)
    const directory = scope() === "project" ? selectedDirectory() : undefined
    if (scope() === "project" && !directory) {
      setError("Төслийн хавтас олдсонгүй. Project scope сонгосон бол хавтас оруулна уу.")
      return
    }

    setBusy(mode)
    try {
      const next = await requestCompatImport({
        sdk: serverSDK(),
        mode,
        payload: payload(),
        directory,
      })
      setResponse(next)
      setPlanKey(currentPlanKey())
      if (mode === "apply") {
        await serverSDK().client.global.dispose().catch(() => undefined)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Интеграц нэмэгдлээ",
          description: `${next.outcomes.filter((item) => item.mode !== "noop").length} өөрчлөлт config-д бичигдлээ`,
        })
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">Интеграц</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-imports">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">Автомат тааруулах</h3>
          <SettingsListV2>
            <div class="settings-v2-import-form">
              <div class="settings-v2-import-grid">
                <label class="settings-v2-import-field">
                  <span>Төрөл</span>
                  <SelectV2
                    options={TYPE_OPTIONS}
                    current={selectedType()}
                    value={(item) => item.value}
                    label={(item) => item.label}
                    onSelect={(item) => item && setType(item.value)}
                  >
                    {(item) => (
                      <div class="settings-v2-import-select-item">
                        <span>{item.label}</span>
                        <small>{item.description}</small>
                      </div>
                    )}
                  </SelectV2>
                </label>

                <label class="settings-v2-import-field">
                  <span>Хамрах хүрээ</span>
                  <SelectV2
                    options={SCOPE_OPTIONS}
                    current={selectedScope()}
                    value={(item) => item.value}
                    label={(item) => item.label}
                    onSelect={(item) => item && setScope(item.value)}
                  >
                    {(item) => (
                      <div class="settings-v2-import-select-item">
                        <span>{item.label}</span>
                        <small>{item.description}</small>
                      </div>
                    )}
                  </SelectV2>
                </label>
              </div>

              <Show when={scope() === "project"}>
                <label class="settings-v2-import-field">
                  <span>Төслийн хавтас</span>
                  <TextInputV2
                    value={selectedDirectory()}
                    onInput={(event) => setProjectDirectory(event.currentTarget.value)}
                    placeholder="C:\work\my-project"
                    spellcheck={false}
                  />
                </label>
              </Show>

              <label class="settings-v2-import-field settings-v2-import-source">
                <span>Эх сурвалж</span>
                <TextareaV2
                  rows={4}
                  value={source()}
                  onInput={(event) => setSource(event.currentTarget.value)}
                  placeholder="npx -y @modelcontextprotocol/server-filesystem C:\work&#10;эсвэл C:\tools\my-skill&#10;эсвэл https://example.com/mcp"
                  spellcheck={false}
                />
              </label>

              <div class="settings-v2-import-grid">
                <label class="settings-v2-import-field">
                  <span>Нэр</span>
                  <TextInputV2
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value)}
                    placeholder="хоосон бол өөрөө нэрлэнэ"
                    spellcheck={false}
                  />
                </label>
                <div class="settings-v2-import-switches">
                  <label>
                    <Switch checked={adapter()} onChange={setAdapter} />
                    <span>Plugin wrapper</span>
                  </label>
                  <label>
                    <Switch checked={force()} onChange={setForce} />
                    <span>Давхар байвал солих</span>
                  </label>
                </div>
              </div>

              <div class="settings-v2-import-grid">
                <label class="settings-v2-import-field">
                  <span>Env</span>
                  <TextareaV2
                    rows={3}
                    value={env()}
                    onInput={(event) => setEnv(event.currentTarget.value)}
                    placeholder="API_KEY=..."
                    spellcheck={false}
                  />
                </label>
                <label class="settings-v2-import-field">
                  <span>Header</span>
                  <TextareaV2
                    rows={3}
                    value={header()}
                    onInput={(event) => setHeader(event.currentTarget.value)}
                    placeholder="Authorization=Bearer ..."
                    spellcheck={false}
                  />
                </label>
              </div>

              <div class="settings-v2-import-actions">
                <ButtonV2
                  size="normal"
                  variant="neutral"
                  icon="plus"
                  disabled={!canRun()}
                  onClick={() => void run("plan")}
                >
                  {busy() === "plan" ? "Шалгаж байна..." : "Төлөвлөгөө гаргах"}
                </ButtonV2>
                <ButtonV2
                  size="normal"
                  variant="contrast"
                  icon="check"
                  disabled={!canApply()}
                  onClick={() => void run("apply")}
                >
                  {busy() === "apply" ? "Суулгаж байна..." : "Суулгах"}
                </ButtonV2>
              </div>
            </div>
          </SettingsListV2>
        </div>

        <Show when={error()}>
          {(message) => <div class="settings-v2-import-error">{message()}</div>}
        </Show>

        <Show when={response()}>
          {(result) => (
            <div class="settings-v2-section settings-v2-import-result">
              <div class="settings-v2-import-result-heading">
                <h3 class="settings-v2-section-title">Илэрсэн өөрчлөлт</h3>
                <Tag>{result().scope === "global" ? "Бүх төсөл" : "Project"}</Tag>
              </div>
              <SettingsListV2>
                <div class="settings-v2-import-config">
                  <span>Config</span>
                  <code>{result().configPath}</code>
                </div>
                <For each={result().outcomes}>
                  {(outcome) => (
                    <div class="settings-v2-import-outcome">
                      <div class="settings-v2-import-outcome-main">
                        <span>{operationTitle(outcome.operation)}</span>
                        <small>{operationDetail(outcome.operation)}</small>
                      </div>
                      <Tag>{outcomeLabel(outcome)}</Tag>
                    </div>
                  )}
                </For>
                <Show when={result().warnings.length > 0}>
                  <div class="settings-v2-import-warnings">
                    <For each={result().warnings}>{(warning) => <span>{warning}</span>}</For>
                  </div>
                </Show>
              </SettingsListV2>
            </div>
          )}
        </Show>
      </div>
    </>
  )
}
