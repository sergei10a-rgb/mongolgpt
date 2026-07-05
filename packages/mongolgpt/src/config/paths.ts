export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@mongolgpt/core/flag/flag"
import { Global } from "@mongolgpt/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@mongolgpt/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.MONGOLGPT_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".mongolgpt"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".mongolgpt"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.MONGOLGPT_CONFIG_DIR ? [Flag.MONGOLGPT_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
