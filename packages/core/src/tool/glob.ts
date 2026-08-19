export * as GlobTool from "./glob"

import { ToolFailure } from "@mongolgpt/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Файл тааруулах glob загвар" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Хайх relative хавтас. Анхдагчаар идэвхтэй Location-ийг ашиглана.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Буцаах үр дүнгийн дээд тоо",
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["Файл олдсонгүй"] : output.map((item) => item.path)
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Идэвхтэй Location дотор glob загвараар файл олно. Товч relative файлын resource-ууд буцаана. Хайлтыг нарийсгахын тулд relative зам, үр дүнгийн тоог хязгаарлахын тулд limit ашиглана.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const cwd = path.resolve(location.directory, input.path ?? ".")
              return yield* ripgrep
                .glob({
                  cwd,
                  pattern: input.pattern,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((entry) =>
                      FileSystem.Entry.make({
                        ...entry,
                        path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                      }),
                    ),
                  ),
                )
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `${input.pattern} загварт тохирох файл олж чадсангүй` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
