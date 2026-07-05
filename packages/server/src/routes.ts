import { Database } from "@mongolgpt/core/database/database"
import { LayerNode, LayerNodeTree } from "@mongolgpt/core/effect/layer-node"
import { httpClient } from "@mongolgpt/core/effect/layer-node-platform"
import { NodeBuild } from "@mongolgpt/core/effect/node-build"
import { EventV2 } from "@mongolgpt/core/event"
import { Credential } from "@mongolgpt/core/credential"
import { PermissionSaved } from "@mongolgpt/core/permission/saved"
import { PtyTicket } from "@mongolgpt/core/pty/ticket"
import { SessionV2 } from "@mongolgpt/core/session"
import { SessionExecution } from "@mongolgpt/core/session/execution"
import { LocationServiceMap } from "@mongolgpt/core/location-service-map"
import { SessionExecutionLocal } from "@mongolgpt/core/session/execution/local"
import { ToolOutputStore } from "@mongolgpt/core/tool-output-store"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.layer({ username: "mongolgpt", password: Option.some(password) })
      : ServerAuth.Config.defaultLayer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.layer({ username: "mongolgpt", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = NodeBuild.build(
    LayerNodeTree.bind(applicationServices, SessionExecution.node, SessionExecutionLocal.node),
  )

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
