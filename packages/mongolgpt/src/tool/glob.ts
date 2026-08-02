import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@mongolgpt/core/fs-util"
import { Ripgrep } from "@mongolgpt/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Файлуудтай тулгах glob загвар" }),
  path: Schema.optional(Schema.String).annotate({
    description: `Хайх хавтас. Тодорхойлоогүй бол одоогийн ажиллаж буй хавтас ашиглана. ЧУХАЛ: Анхдагч хавтас ашиглах бол энэ талбарыг орхино уу. "undefined" эсвэл "null" бүү оруул, зүгээр л орхино уу. Өгсөн тохиолдолд хүчинтэй хавтасны зам байх ёстой.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob-ийн зам нь хавтас байх ёстой: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = 100
          const files = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit })
          const truncated = files.length === limit

          const output = []
          if (files.length === 0) output.push("Файл олдсонгүй")
          if (files.length > 0) {
            output.push(...files.map((file) => path.resolve(search, file.path)))
            if (truncated) {
              output.push("")
              output.push(
                `(Үр дүн таслагдсан: эхний ${limit}-ыг харуулж байна. Илүү тодорхой зам эсвэл хайлтын загвар ашиглана уу.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
