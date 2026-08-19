import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String.annotate({ description: "VCS patch хэрэглэх үеийн алдааны тайлбар" }),
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Инстансыг устгасан"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Инстансыг устгах",
            description: "Одоогийн MongolGPT инстансыг цэвэрлэн устгаж, бүх нөөцийг чөлөөлнө.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Замуудыг авах",
            description:
              "MongolGPT инстансын одоогийн ажлын сан болон холбогдох замын мэдээллийг авна.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS мэдээлэл"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "VCS мэдээллийг авах",
            description:
              "Одоогийн төслийн хувилбарын хяналтын системийн (VCS) мэдээлэл, тухайлбал git салбарыг авна.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS төлөв"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "VCS төлөвийг авах",
            description: "Одоогийн ажлын модонд өөрчлөгдсөн файлуудыг patch-гүйгээр авна.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS-ийн ялгаа"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "VCS-ийн ялгааг авах",
            description: "Ажлын модны одоогийн git diff эсвэл өгөгдмөл салбартай харьцуулсан ялгааг авна.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Түүхий VCS-ийн ялгааг авах",
            description: "Одоогоор баталгаажуулж хадгалаагүй өөрчлөлтийн боловсруулаагүй нөхөөсийг авна.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch-ийг хэрэглэсэн"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "VCS patch хэрэглэх",
            description: "Одоогийн ажлын модонд түүхий patch хэрэглэнэ.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "Командуудын жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "Командуудыг жагсаах",
            description: "MongolGPT системд ашиглах боломжтой бүх командын жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "Агентуудын жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "Агентуудыг жагсаах",
            description: "MongolGPT системд ашиглах боломжтой бүх AI агентын жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "Ур чадваруудын жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "Ур чадваруудыг жагсаах",
            description: "MongolGPT системд ашиглах боломжтой бүх ур чадварын жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP серверийн төлөв"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "LSP төлөвийг авах",
            description: "LSP серверийн төлөвийг авна.",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Форматлагчийн төлөв"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Форматлагчийн төлөвийг авах",
            description: "Форматлагчийн төлөвийг авна.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Инстанс",
          description: "Туршилтын HttpApi инстанс унших замууд.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "MongolGPT-ийн туршилтын HttpApi",
      version: "0.0.1",
      description: "Инстансын сонгосон замуудыг хамарсан туршилтын HttpApi интерфейс.",
    }),
  )
