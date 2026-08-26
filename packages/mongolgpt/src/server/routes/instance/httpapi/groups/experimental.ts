import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt, PositiveInt } from "@mongolgpt/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@mongolgpt/core/provider"
import { ModelV2 } from "@mongolgpt/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

const AccountPublic = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  url: Schema.String,
  activeOrgID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "ExperimentalAccount" })

const AccountLoginPayload = Schema.Struct({
  server: Schema.String,
})

const AccountLoginStarted = Schema.Struct({
  loginID: Schema.String,
  url: Schema.String,
})

const AccountLoginStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("pending") }),
  Schema.Struct({ _tag: Schema.Literal("success"), id: Schema.String, email: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("error"), message: Schema.String }),
]).annotate({ identifier: "ExperimentalAccountLoginStatus" })

const AccountOverviewIdentifier = Schema.String.check(Schema.isMinLength(5), Schema.isMaxLength(30))
const AccountOverviewTimestamp = NonNegativeInt
const PaidPlan = Schema.Literals(["basic", "pro", "max"])

const AccountOverviewSubscription = Schema.Struct({
  id: AccountOverviewIdentifier,
  invoiceID: AccountOverviewIdentifier,
  plan: PaidPlan,
  status: Schema.Literal("active"),
  periodStart: AccountOverviewTimestamp,
  periodEnd: AccountOverviewTimestamp,
})

const AccountOverviewLimits = Schema.Union([
  Schema.Struct({
    plan: Schema.Literal("free"),
    promoTokens: NonNegativeInt,
    dailyRequests: PositiveInt,
    dailyRequestsFallback: PositiveInt,
  }),
  Schema.Struct({
    plan: PaidPlan,
    weeklyCostLimitInMicroCents: PositiveInt,
    weeklyTokenLimit: PositiveInt,
    rollingCostLimitInMicroCents: PositiveInt,
    rollingWindowHours: PositiveInt,
  }),
])

const AccountOverviewQuotaDimension = Schema.Struct({
  used: NonNegativeInt,
  limit: PositiveInt,
  resetAt: Schema.NullOr(AccountOverviewTimestamp),
})

const AccountOverviewQuota = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    weeklyCost: AccountOverviewQuotaDimension,
    weeklyTokens: AccountOverviewQuotaDimension,
    rollingCost: AccountOverviewQuotaDimension,
  }),
  Schema.Struct({
    status: Schema.Literal("model-scoped"),
    reason: Schema.Literal("free-auto-model-limits"),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literal("quota-service-unavailable"),
  }),
])

const AccountOverviewUsage = Schema.Struct({
  scope: Schema.Literal("workspace"),
  period: Schema.Literals(["week", "subscription"]),
  periodStart: AccountOverviewTimestamp,
  periodEnd: AccountOverviewTimestamp,
  requestCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  costInMicroCents: NonNegativeInt,
})

const AccountOverviewResponse = Schema.Struct({
  account: Schema.Struct({
    id: AccountOverviewIdentifier,
    email: Schema.String.check(Schema.isMaxLength(320)),
    status: Schema.Literal("active"),
    createdAt: AccountOverviewTimestamp,
  }),
  currentWorkspaceID: Schema.NullOr(AccountOverviewIdentifier),
  workspaces: Schema.Array(
    Schema.Struct({
      id: AccountOverviewIdentifier,
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
      slug: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
      userID: AccountOverviewIdentifier,
      role: Schema.Literals(["admin", "member"]),
      subscription: Schema.NullOr(AccountOverviewSubscription),
      limits: AccountOverviewLimits,
      quota: AccountOverviewQuota,
      usage: AccountOverviewUsage,
    }),
  ),
}).annotate({ identifier: "ExperimentalAccountOverview" })

export const AccountOverviewQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  workspaceID: Schema.optional(OrgID),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({
      message: Schema.String.annotate({ description: "Төслийн хуулбарын үйлдлийн алдааны тайлбар" }),
    }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  account: "/experimental/account",
  accountOverview: "/experimental/account/overview",
  accountLogin: "/experimental/account/login",
  accountLoginStatus: "/experimental/account/login/:loginID",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("account", ExperimentalPaths.account, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.NullOr(AccountPublic), "Идэвхтэй локал бүртгэл"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.account.get",
            summary: "Идэвхтэй локал бүртгэлийг авах",
            description:
              "Идэвхтэй локал бүртгэлийн нийтэд харуулах таних мэдээлэл болон идэвхтэй байгууллагын ID-г авна. Токеныг хэзээ ч буцаахгүй.",
          }),
        ),
        HttpApiEndpoint.delete("accountRemove", ExperimentalPaths.account, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Локал бүртгэлийг устгасан"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.account.remove",
            summary: "Идэвхтэй локал бүртгэлийг устгах",
            description:
              "Энэ локал MongolGPT хувилбараас идэвхтэй бүртгэлийг устгана. Алсын токенуудыг хүчингүй болгохгүй.",
          }),
        ),
        HttpApiEndpoint.get("accountOverview", ExperimentalPaths.accountOverview, {
          query: AccountOverviewQuery,
          success: described(Schema.NullOr(AccountOverviewResponse), "Идэвхтэй бүртгэлийн багц, квот болон хэрэглээ"),
          error: [HttpApiError.InternalServerError, HttpApiError.ServiceUnavailable],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.account.overview",
            summary: "Идэвхтэй бүртгэлийн багц, квот болон хэрэглээг авах",
            description:
              "Идэвхтэй MongolGPT бүртгэлийн алсын API-аар баталгаажсан ажлын орчин, багц, хэрэглээний хязгаар болон зарцуулалтын мэдээллийг авна. Нууц токен буцаахгүй.",
          }),
        ),
        HttpApiEndpoint.post("accountLogin", ExperimentalPaths.accountLogin, {
          query: WorkspaceRoutingQuery,
          payload: AccountLoginPayload,
          success: described(AccountLoginStarted, "Хөтчөөр нэвтрэх үйлдэл эхэлсэн"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.account.login",
            summary: "Хөтчөөр бүртгэлд нэвтрэх үйлдлийг эхлүүлэх",
            description:
              "Локал хөтөч дээр OAuth нэвтрэлтийг эхлүүлж, зөвшөөрлийн URL болон түр нэвтрэлтийн ID-г буцаана.",
          }),
        ),
        HttpApiEndpoint.get("accountLoginStatus", ExperimentalPaths.accountLoginStatus, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AccountLoginStatus, "Хөтчийн нэвтрэлтийн төлөв"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.account.loginStatus",
            summary: "Хөтчийн нэвтрэлтийн төлөвийг авах",
            description:
              "Хөтчийн түр нэвтрэлтийн төлөвийг авна. Дууссан төлөвийн бичлэг богино хугацааны дараа хүчингүй болно.",
          }),
        ),
        HttpApiEndpoint.delete("accountLoginCancel", ExperimentalPaths.accountLoginStatus, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Хөтчийн нэвтрэлтийг цуцалсан"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.account.loginCancel",
            summary: "Хөтчөөр бүртгэлд нэвтрэх үйлдлийг цуцлах",
            description: "Хүлээгдэж буй локал хөтчийн OAuth нэвтрэлтийг цуцалж устгана.",
          }),
        ),
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Туршилтын боломжууд"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Туршилтын боломжуудыг авах",
            description: "MongolGPT сервер дээр идэвхжсэн туршилтын боломжуудыг авна.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Идэвхтэй Console үйлчилгээ үзүүлэгчийн мета өгөгдөл"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Идэвхтэй Console үйлчилгээ үзүүлэгчийн мета өгөгдлийг авах",
            description:
              "Идэвхтэй Console байгууллагын нэр болон тус байгууллагын удирддаг үйлчилгээ үзүүлэгчийн ID-нуудыг авна.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Сольж болох Console байгууллагууд"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "Сольж болох Console байгууллагуудыг жагсаах",
            description:
              "Нэвтэрсэн бүртгэлүүдэд байгаа Console байгууллагуудыг одоогийн идэвхтэй байгууллагын хамт авна.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Солих үйлдэл амжилттай"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Идэвхтэй Console байгууллагыг солих",
            description:
              "Одоогийн локал MongolGPT төлөвт Console бүртгэл болон байгууллагын шинэ идэвхтэй сонголтыг хадгална.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Хэрэгслүүд"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "Хэрэгслүүдийг жагсаах",
            description:
              "Тодорхой үйлчилгээ үзүүлэгч болон загварын хослолд ашиглах боломжтой хэрэгслүүдийг JSON схемийн параметрийн хамт авна.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Хэрэгслийн ID-нууд"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "Хэрэгслийн ID-нуудыг жагсаах",
            description: "Суурилуулсан болон динамикаар бүртгэсэн бүх хэрэгслийн ID-ны жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "Төслийн хуулбаруудын жагсаалт"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "Төслийн хуулбаруудыг жагсаах",
            description: "Одоогийн төслийн тусгаарласан бүх төслийн хуулбарыг жагсаана.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Төслийн хуулбар үүссэн"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Төслийн хуулбар үүсгэх",
            description:
              "Одоогийн төсөлд шинэ git төслийн хуулбар үүсгэж, тохируулсан эхлүүлэх скриптүүдийг ажиллуулна.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Төслийн хуулбарыг устгасан"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Төслийн хуулбарыг устгах",
            description: "Git төслийн хуулбар болон түүнд харьяалагдах салбарыг устгана.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Төслийн хуулбарыг анхны төлөвт оруулсан"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Төслийн хуулбарыг анхны төлөвт оруулах",
            description: "Төслийн хуулбарын салбарыг үндсэн өгөгдмөл салбарын төлөвт оруулна.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "Сессүүдийн жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "Сессүүдийг жагсаах",
            description:
              "Төслүүдийн бүх MongolGPT сессийг хамгийн сүүлд шинэчлэгдсэн дарааллаар авна. Архивласан сессүүдийг өгөгдмөлөөр оруулахгүй.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Арын горимд шилжүүлсэн дэд агентууд"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Дэд агентуудыг арын горимд шилжүүлэх",
            description: "Сессийг саатуулж буй синхрон дэд агентуудыг салгаж, арын горимд үргэлжлүүлэн ажиллуулна.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP нөөцүүд"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "MCP нөөцүүдийг авах",
            description: "Холбогдсон серверүүдийн бүх MCP нөөцийг авна. Нэрээр нь шүүж болно.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Туршилтын API",
          description: "Туршилтын HttpApi замууд.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MongolGPT туршилтын HttpApi",
      version: "0.0.1",
      description: "Сонгосон инстансын замуудад зориулсан туршилтын HttpApi интерфэйс.",
    }),
  )
