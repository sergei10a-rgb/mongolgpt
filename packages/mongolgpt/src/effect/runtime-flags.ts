import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const mongolName = (name: string) =>
  name.startsWith("MONGOLGPT_") ? `MONGOLGPT_${name.slice("MONGOLGPT_".length)}` : name
const config = (name: string) => Config.string(mongolName(name)).pipe(Config.orElse(() => Config.string(name)))
const bool = (name: string) =>
  Config.boolean(mongolName(name)).pipe(
    Config.orElse(() => Config.boolean(name)),
    Config.withDefault(false),
  )
const positiveInteger = (name: string) =>
  Config.number(mongolName(name)).pipe(
    Config.orElse(() => Config.number(name)),
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("MONGOLGPT_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@mongolgpt/RuntimeFlags", {
  autoShare: bool("MONGOLGPT_AUTO_SHARE"),
  pure: bool("MONGOLGPT_PURE"),
  disableDefaultPlugins: bool("MONGOLGPT_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("MONGOLGPT_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("MONGOLGPT_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("MONGOLGPT_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("MONGOLGPT_DISABLE_CLAUDE_CODE"),
    direct: bool("MONGOLGPT_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("MONGOLGPT_DISABLE_CLAUDE_CODE"),
    direct: bool("MONGOLGPT_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("MONGOLGPT_ENABLE_EXA"),
    legacy: bool("MONGOLGPT_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("MONGOLGPT_ENABLE_PARALLEL"),
    legacy: bool("MONGOLGPT_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("MONGOLGPT_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("MONGOLGPT_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("MONGOLGPT_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("MONGOLGPT_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("MONGOLGPT_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("MONGOLGPT_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("MONGOLGPT_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("MONGOLGPT_EXPERIMENTAL_WEBSOCKETS"),
  client: config("MONGOLGPT_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@mongolgpt/core/effect/layer-node"
