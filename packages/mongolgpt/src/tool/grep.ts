import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@mongolgpt/core/fs-util"
import { Ripgrep } from "@mongolgpt/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Файлын агуулгаас хайх regex pattern" }),
  path: Schema.optional(Schema.String).annotate({
    description: "Хайх directory. Тодорхойлоогүй бол одоогийн working directory ашиглана.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'Хайлтад оруулах файлын pattern (жишээ нь "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "Файл олдсонгүй",
          }
          if (!params.pattern) {
            throw new Error("pattern шаардлагатай")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            include: params.include,
            limit: 100,
          })
          if (result.length === 0) return empty

          const rows = result.map((item) => ({
            path: path.resolve(cwd, item.entry.path),
            line: item.line,
            text: item.text,
          }))

          const limit = 100
          const truncated = rows.length === limit
          const final = rows
          if (final.length === 0) return empty

          const total = rows.length
          const hasMore = truncated || result.length === limit
          const output = [`${total} тохирол олдлоо${hasMore ? " (илүү тохирол байна)" : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  ${match.line}-р мөр: ${match.text}`)
          }

          if (truncated) {
            output.push("")
            output.push("(Үр дүн таслагдсан. Илүү тодорхой path эсвэл pattern ашиглана уу.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
