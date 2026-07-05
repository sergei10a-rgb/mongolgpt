import { Credential } from "@mongolgpt/core/credential"
import { EventV2 } from "@mongolgpt/core/event"
import { FileSystem } from "@mongolgpt/core/filesystem"
import { FSUtil } from "@mongolgpt/core/fs-util"
import { Global } from "@mongolgpt/core/global"
import { Npm } from "@mongolgpt/core/npm"
import { PluginV2 } from "@mongolgpt/core/plugin"
import { RepositoryCache } from "@mongolgpt/core/repository-cache"
import { Ripgrep } from "@mongolgpt/core/ripgrep"
import { SkillDiscovery } from "@mongolgpt/core/skill/discovery"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { tempLocationLayer } from "../fixture/location"

export const PluginTestLayer = Layer.mergeAll(FileSystem.locationLayer, PluginV2.locationLayer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Credential.defaultLayer,
      EventV2.defaultLayer,
      FetchHttpClient.layer,
      FSUtil.defaultLayer,
      Global.defaultLayer,
      Layer.succeed(
        Npm.Service,
        Npm.Service.of({
          add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
          install: () => Effect.void,
          which: () => Effect.succeed(undefined),
        }),
      ),
      RepositoryCache.defaultLayer,
      SkillDiscovery.defaultLayer,
      Ripgrep.defaultLayer,
      tempLocationLayer,
    ),
  ),
)
