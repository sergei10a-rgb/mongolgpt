export * as ConfigAgentV1 from "./agent"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String).annotate({
      description: "Энэ агентын өгөгдмөл загварын хувилбар (зөвхөн агентын тохируулсан загварыг ашиглах үед үйлчилнэ).",
    }),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated 'permission' талбарыг ашиглана уу",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Агентыг ямар үед ашиглах тухай тайлбар" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Энэ дэд агентыг @ автоматаар гүйцээх цэснээс нуух (өгөгдмөл: false, зөвхөн mode: subagent үед үйлчилнэ)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex өнгөний код (жишээ нь #FF5733) эсвэл өнгөний сэдвийн утга (жишээ нь primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Зөвхөн текстээр хариу өгөхөөс өмнөх агентын давталтын дээд тоо",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated 'steps' талбарыг ашиглана уу." }),
    permission: Schema.optional(ConfigPermissionV1.Info),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "disable",
  "tools",
])

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const permission: ConfigPermissionV1.Info = {}
  for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  globalThis.Object.assign(permission, agent.permission)

  const steps = agent.steps ?? agent.maxSteps
  return { ...agent, options, permission, ...(steps !== undefined ? { steps } : {}) }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
