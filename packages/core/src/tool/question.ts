export * as QuestionTool from "./question"

import { ToolFailure } from "@mongolgpt/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "question"

export const description = `Ажиллах явцад хэрэглэгчээс асуулт асуух шаардлагатай үед энэ хэрэгслийг ашиглана. Үүгээр:
1. Хэрэглэгчийн хүсэл, шаардлагыг цуглуулна
2. Тодорхой бус зааврыг тодруулна
3. Хэрэгжүүлэх сонголтын талаар шийдвэр авна
4. Цааш ямар чиглэл сонгохыг хэрэглэгчид санал болгоно.

Ашиглах тэмдэглэл:
- \`custom\` идэвхтэй үед (анхдагч) "Өөрийн хариултыг бичих" сонголт автоматаар нэмэгдэнэ; "Other" эсвэл ерөнхий нөхөх сонголт бүү нэм
- Хариултыг label-ийн массив хэлбэрээр буцаана; нэгээс олон сонголт зөвшөөрөхдөө \`multiple: true\` тохируулна
- Тодорхой сонголт санал болговол жагсаалтын эхэнд байрлуулж, label-ийн төгсгөлд "(Recommended)" нэм`

export const Input = Schema.Struct({
  questions: Schema.Array(QuestionV2.Prompt).annotate({ description: "Асуух асуултууд" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(QuestionV2.Answer),
})
export type Output = typeof Output.Type

export const toModelOutput = (
  questions: ReadonlyArray<QuestionV2.Prompt>,
  answers: ReadonlyArray<QuestionV2.Answer>,
) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Хариулаагүй"}"`,
    )
    .join(", ")
  return `Хэрэглэгч таны асуултад хариуллаа: ${formatted}. Одоо хэрэглэгчийн хариултыг харгалзан үргэлжлүүлж болно.`
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            { type: "text", text: toModelOutput(input.questions, output.answers) },
          ],
          execute: (input, context) =>
            permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: "Зөвшөөрөл олгогдсонгүй: question" })),
                Effect.andThen(
                  question
                    .ask({
                      sessionID: context.sessionID,
                      questions: input.questions,
                      tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    .pipe(Effect.orDie),
                ),
                Effect.map((answers) => ({ answers })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
