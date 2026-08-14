import { ButtonV2 } from "@mongolgpt/ui/v2/button-v2"
import { SelectV2 } from "@mongolgpt/ui/v2/select-v2"
import { Switch } from "@mongolgpt/ui/v2/switch-v2"
import { Tag } from "@mongolgpt/ui/v2/badge-v2"
import { TextareaV2 } from "@mongolgpt/ui/v2/textarea-v2"
import { TextInputV2 } from "@mongolgpt/ui/v2/text-input-v2"
import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
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

function operationTitle(operation: CompatOperation, t: (key: string) => string) {
  switch (operation.kind) {
    case "mcp":
      return `${t("settings.imports.operation.mcp")}: ${operation.name ?? t("settings.imports.operation.server")}`
    case "skill-path":
      return t("settings.imports.operation.skillPath")
    case "skill-url":
      return t("settings.imports.operation.skillUrl")
    case "plugin": {
      const spec = Array.isArray(operation.spec) ? operation.spec[0] : operation.spec
      return `${t("settings.imports.operation.plugin")}: ${spec ?? operation.source}`
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

function outcomeLabel(outcome: CompatPatchOutcome, t: (key: string) => string) {
  if (outcome.mode === "add") return t("settings.imports.outcome.add")
  if (outcome.mode === "replace") return t("settings.imports.outcome.replace")
  return t("settings.imports.outcome.noop")
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
  const language = useLanguage()
  const translate = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const typeOptions = createMemo<Option<CompatImportType>[]>(() => [
    {
      value: "auto",
      label: language.t("settings.imports.type.auto"),
      description: language.t("settings.imports.type.auto.description"),
    },
    { value: "mcp", label: "MCP", description: language.t("settings.imports.type.mcp.description") },
    {
      value: "skill",
      label: language.t("settings.imports.type.skill"),
      description: language.t("settings.imports.type.skill.description"),
    },
    {
      value: "plugin",
      label: language.t("settings.imports.type.plugin"),
      description: language.t("settings.imports.type.plugin.description"),
    },
  ])
  const scopeOptions = createMemo<Option<CompatImportScope>[]>(() => [
    {
      value: "global",
      label: language.t("settings.imports.scope.global"),
      description: language.t("settings.imports.scope.global.description"),
    },
    {
      value: "project",
      label: language.t("settings.imports.scope.project"),
      description: language.t("settings.imports.scope.project.description"),
    },
  ])

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
  const selectedType = createMemo(() => typeOptions().find((item) => item.value === type()) ?? typeOptions()[0])
  const selectedScope = createMemo(() => scopeOptions().find((item) => item.value === scope()) ?? scopeOptions()[0])
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
      setError(language.t("settings.imports.error.projectDirectoryRequired"))
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
        await serverSDK()
          .client.global.dispose()
          .catch(() => undefined)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.imports.toast.applied.title"),
          description: language.t("settings.imports.toast.applied.description", {
            count: next.outcomes.filter((item) => item.mode !== "noop").length,
          }),
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
        <h2 class="settings-v2-tab-title">{language.t("settings.imports.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-imports">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.imports.section.title")}</h3>
          <SettingsListV2>
            <div class="settings-v2-import-form">
              <div class="settings-v2-import-grid">
                <label class="settings-v2-import-field">
                  <span>Төрөл</span>
                  <SelectV2
                    options={typeOptions()}
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
                    options={scopeOptions()}
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
                    <span>{language.t("settings.imports.adapter")}</span>
                  </label>
                  <label>
                    <Switch checked={force()} onChange={setForce} />
                    <span>Давхар байвал солих</span>
                  </label>
                </div>
              </div>

              <div class="settings-v2-import-grid">
                <label class="settings-v2-import-field">
                  <span>{language.t("settings.imports.environment")}</span>
                  <TextareaV2
                    rows={3}
                    value={env()}
                    onInput={(event) => setEnv(event.currentTarget.value)}
                    placeholder="API_KEY=..."
                    spellcheck={false}
                  />
                </label>
                <label class="settings-v2-import-field">
                  <span>{language.t("settings.imports.header")}</span>
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

        <Show when={error()}>{(message) => <div class="settings-v2-import-error">{message()}</div>}</Show>

        <Show when={response()}>
          {(result) => (
            <div class="settings-v2-section settings-v2-import-result">
              <div class="settings-v2-import-result-heading">
                <h3 class="settings-v2-section-title">Илэрсэн өөрчлөлт</h3>
                <Tag>
                  {result().scope === "global"
                    ? language.t("settings.imports.scope.global")
                    : language.t("settings.imports.scope.project")}
                </Tag>
              </div>
              <SettingsListV2>
                <div class="settings-v2-import-config">
                  <span>{language.t("settings.imports.config")}</span>
                  <code>{result().configPath}</code>
                </div>
                <For each={result().outcomes}>
                  {(outcome) => (
                    <div class="settings-v2-import-outcome">
                      <div class="settings-v2-import-outcome-main">
                        <span>{operationTitle(outcome.operation, translate)}</span>
                        <small>{operationDetail(outcome.operation)}</small>
                      </div>
                      <Tag>{outcomeLabel(outcome, translate)}</Tag>
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
