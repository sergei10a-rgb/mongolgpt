export * as SkillTool from "./skill"

import path from "path"
import { ToolFailure } from "@mongolgpt/llm"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill"
const FILE_LIMIT = 10

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "Боломжтой ур чадварын жагсаалтаас сонгох ур чадварын нэр" }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  output: Schema.String,
})

export const description = [
  "Одоогийн даалгавар системийн орчинд байгаа ур чадваруудын аль нэгтэй таарвал тухайн тусгай ур чадварыг ачаална.",
  "",
  "Энэ хэрэгслээр ур чадварын заавар болон resource-уудыг одоогийн ярианд оруулна. Гаралтад ажлын урсгалын дэлгэрэнгүй заавар, мөн тухайн ур чадвартай нэг хавтас дахь script, файл зэрэгт хандах лавлагаа байж болно.",
  "",
  "Ур чадварын нэр нь системийн орчинд байгаа ур чадварын аль нэгтэй яг таарсан байх ёстой.",
].join("\n")

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${skill.name}">`,
    `# Ур чадвар: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Энэ ур чадварын үндсэн хавтас: ${directory}`,
    "Энэ ур чадварын relative замууд (жишээ нь scripts/, reference/) нь дээрх үндсэн хавтастай харьцангуй.",
    "Тайлбар: файлын жагсаалтыг түүвэрлэн харуулсан.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Ур чадварыг ачаалж чадсангүй: ${name}`, error })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const skills = yield* SkillV2.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* skills.list()
              const skill = current.find((skill) => skill.name === input.name)
              if (!skill) return yield* unableToLoad(input.name)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const directory = path.dirname(skill.location)
                const files =
                  path.basename(skill.location) === "SKILL.md"
                    ? (yield* fs.glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                        .filter((file) => path.basename(file) !== "SKILL.md")
                        .toSorted()
                        .slice(0, FILE_LIMIT)
                    : []
                return {
                  name: skill.name,
                  directory,
                  output: toModelOutput(skill, files),
                }
              }).pipe(Effect.mapError((error) => unableToLoad(input.name, error)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
