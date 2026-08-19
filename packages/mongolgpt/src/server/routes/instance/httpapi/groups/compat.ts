import { ConfigMCPV1 } from "@mongolgpt/core/v1/config/mcp"
import { ConfigPluginV1 } from "@mongolgpt/core/v1/config/plugin"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const CompatType = Schema.Literals(["auto", "mcp", "skill", "plugin"])
const CompatScope = Schema.Literals(["global", "project"])

export const CompatImportPayload = Schema.Struct({
  source: Schema.optional(Schema.String),
  type: Schema.optional(CompatType),
  name: Schema.optional(Schema.String),
  scope: Schema.optional(CompatScope),
  project: Schema.optional(Schema.Boolean),
  mcpCommand: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Array(Schema.String)),
  header: Schema.optional(Schema.Array(Schema.String)),
  force: Schema.optional(Schema.Boolean),
  adapter: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "CompatImportPayload" })

const CompatAdapterPlan = Schema.Struct({
  file: Schema.String,
  target: Schema.String,
  format: Schema.String,
  original: Schema.String,
}).annotate({ identifier: "CompatAdapterPlan" })

const CompatMcpOperation = Schema.Struct({
  kind: Schema.Literal("mcp"),
  name: Schema.String,
  config: ConfigMCPV1.Info,
  source: Schema.String,
})

const CompatSkillPathOperation = Schema.Struct({
  kind: Schema.Literal("skill-path"),
  value: Schema.String,
  source: Schema.String,
})

const CompatSkillUrlOperation = Schema.Struct({
  kind: Schema.Literal("skill-url"),
  value: Schema.String,
  source: Schema.String,
})

const CompatPluginOperation = Schema.Struct({
  kind: Schema.Literal("plugin"),
  spec: ConfigPluginV1.Spec,
  source: Schema.String,
  adapter: Schema.optional(CompatAdapterPlan),
})

const CompatOperation = Schema.Union([
  CompatMcpOperation,
  CompatSkillPathOperation,
  CompatSkillUrlOperation,
  CompatPluginOperation,
]).annotate({ identifier: "CompatOperation" })

const CompatPatchOutcome = Schema.Struct({
  mode: Schema.Literals(["add", "replace", "noop"]),
  operation: CompatOperation,
}).annotate({ identifier: "CompatPatchOutcome" })

export const CompatImportResponse = Schema.Struct({
  scope: CompatScope,
  configPath: Schema.String,
  operations: Schema.Array(CompatOperation),
  prepared: Schema.Array(CompatOperation),
  descriptions: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  outcomes: Schema.Array(CompatPatchOutcome),
  existingConfigText: Schema.String,
  nextConfigText: Schema.String,
  configExists: Schema.Boolean,
}).annotate({ identifier: "CompatImportResponse" })

export class CompatImportError extends Schema.ErrorClass<CompatImportError>("CompatImportError")(
  { message: Schema.String.annotate({ description: "Нийцтэй байдлын импортын алдааны тайлбар" }) },
  { httpApiStatus: 400 },
) {}

export const CompatPaths = {
  plan: "/compat/import/plan",
  apply: "/compat/import/apply",
} as const

export const CompatApi = HttpApi.make("compat")
  .add(
    HttpApiGroup.make("compat")
      .add(
        HttpApiEndpoint.post("plan", CompatPaths.plan, {
          query: WorkspaceRoutingQuery,
          payload: CompatImportPayload,
          success: described(CompatImportResponse, "MongolGPT-ийн нийцтэй байдлын импортын төлөвлөгөө"),
          error: CompatImportError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "compat.import.plan",
            summary: "Нийцтэй байдлын импорт төлөвлөх",
            description: "Гаднын ур чадвар, залгаас эсвэл MCP тохиргоог MongolGPT-д хэрхэн тохируулахыг төлөвлөнө.",
          }),
        ),
        HttpApiEndpoint.post("apply", CompatPaths.apply, {
          query: WorkspaceRoutingQuery,
          payload: CompatImportPayload,
          success: described(CompatImportResponse, "MongolGPT-ийн нийцтэй байдлын импортын үр дүн"),
          error: CompatImportError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "compat.import.apply",
            summary: "Нийцтэй байдлын импорт хэрэгжүүлэх",
            description: "Төлөвлөсөн нийцтэй байдлын импортыг идэвхтэй MongolGPT инстанцын тохиргоонд хэрэгжүүлнэ.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Нийцтэй байдлын импорт",
          description: "MongolGPT-д зориулсан нийцтэй байдлын импортын маршрутууд.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MongolGPT-ийн нийцтэй байдлын HttpApi",
      version: "0.0.1",
      description:
        "Гаднын AI агентын ур чадвар, залгаас болон MCP холбогчийг MongolGPT-д импортлох төрөл тодорхойлсон замууд.",
    }),
  )
