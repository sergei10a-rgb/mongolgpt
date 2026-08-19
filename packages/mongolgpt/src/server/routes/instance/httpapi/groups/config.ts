import { Config } from "@/config/config"
import { ConfigV1 } from "@mongolgpt/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Тохиргооны мэдээлэл авах"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Тохиргоог авах",
            description: "Одоогийн MongolGPT тохиргоо болон сонголтуудыг авна.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Тохиргоог амжилттай шинэчилсэн"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Тохиргоог шинэчлэх",
            description: "MongolGPT тохиргоо болон сонголтуудыг шинэчилнэ.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "Провайдеруудын жагсаалт"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "Тохируулсан провайдеруудыг жагсаах",
            description: "Тохируулсан бүх AI провайдер болон тэдгээрийн өгөгдмөл загварын жагсаалтыг авна.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "Тохиргоо",
          description: "Туршилтын HttpApi тохиргооны замууд.",
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
