/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@mongolgpt/llm"
import { FileDiff } from "@mongolgpt/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "Засах файлын зам. Relative замыг идэвхтэй Location дотор бодно. Тухайн Location доторх absolute замыг зөвшөөрнө; гаднах absolute замд external_directory зөвшөөрөл шаардлагатай.",
  }),
  oldString: Schema.String.annotate({ description: "Орлуулах яг текст" }),
  newString: Schema.String.annotate({ description: "oldString-оос ялгаатай байх орлуулах текст" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "oldString-ийн бүх яг тохирлыг солих эсэх (анхдагч нь false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const countOccurrences = (content: string, search: string) => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Файлыг амжилттай заслаа: ${output.files[0]?.file}`,
    `Орлуулсан тоо: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Нэг файл дахь яг текстийг солино. Relative замыг идэвхтэй Location дотор бодно. Location доторх absolute замыг зөвшөөрнө. Гадагш чиглэсэн absolute замд edit зөвшөөрөхөөс өмнө external_directory зөвшөөрөл шаардлагатай.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              { type: "text", text: toModelOutput(output, input.oldString, input.newString) },
            ],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) =>
                    error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({
                          message: "Зөвшөөрөл өгснөөс хойш файл өөрчлөгдсөн байна. Засахаас өмнө дахин уншина уу.",
                        })
                      : new ToolFailure({ message: `${input.path} файлыг засах боломжгүй` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "Хэрэгжүүлэх өөрчлөлт алга: oldString болон newString ижил байна.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString хоосон байж болохгүй. Файл үүсгэх эсвэл дарж бичихдээ write ашиглана уу.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const ending = detectLineEnding(source.text)
                const oldString = convertToLineEnding(input.oldString, ending)
                const newString = convertToLineEnding(input.newString, ending)
                const replacements = countOccurrences(source.text, oldString)
                if (replacements === 0) {
                  return yield* new ToolFailure({
                    message:
                      "Файлаас oldString олдсонгүй. Зай болон догол мөрийг багтаасан яг тохирол байх ёстой.",
                  })
                }
                if (replacements > 1 && input.replaceAll !== true) {
                  return yield* new ToolFailure({
                    message:
                      "oldString-т олон яг тохирол олдлоо. Ойролцоох контекстийг нэмэх эсвэл replaceAll-ыг true болгоно уу.",
                  })
                }

                const replaced =
                  input.replaceAll === true
                    ? source.text.replaceAll(oldString, newString)
                    : source.text.replace(oldString, newString)
                const counts = diffLines(source.text, replaced).reduce(
                  (result, item) => ({
                    additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                const next = splitBom(replaced)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                  }),
                )
                return {
                  files: [
                    {
                      file: result.resource,
                      patch: createTwoFilesPatch(result.resource, result.resource, source.text, replaced),
                      status: "modified" as const,
                      ...counts,
                    },
                  ],
                  replacements,
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)
