import { Project } from "@/project/project"
import { ProjectV2 } from "@mongolgpt/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Info.fields.icon),
  commands: Schema.optional(Project.Info.fields.commands),
})

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Project.Info), "Төслүүдийн жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "Бүх төслийг жагсаах",
            description: "MongolGPT-ээр нээсэн төслүүдийн жагсаалтыг авна.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Одоогийн төслийн мэдээлэл"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Одоогийн төслийг авах",
            description: "MongolGPT-ийн ажиллаж буй идэвхтэй төслийг авна.",
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "git эхлүүлсний дараах төслийн мэдээлэл"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "git репозиторыг эхлүүлэх",
            description: "Одоогийн төсөлд git репозитор үүсгээд шинэчилсэн төслийн мэдээллийг буцаана.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Project.Info, "Шинэчилсэн төслийн мэдээлэл"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Төслийг шинэчлэх",
            description: "Төслийн нэр, дүрс, команд зэрэг шинж чанарыг шинэчилнэ.",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Төслийн сангууд"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "Төслийн сангуудыг жагсаах",
            description: "Төсөлд бүртгэлтэй локал абсолют сангуудыг жагсаана.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Төсөл",
          description: "Туршилтын HttpApi төслийн замууд.",
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
