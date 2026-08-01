import path from "path"
import { SessionV1 } from "@mongolgpt/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `${plan} дахь plan дууслаа. Build agent руу шилжиж хэрэгжүүлж эхлэх үү?`,
                header: "Build agent",
                custom: false,
                options: [
                  { label: "Тийм", description: "Build agent руу шилжиж plan-ийг хэрэгжүүлж эхлэх" },
                  { label: "Үгүй", description: "Plan agent дээр үлдэж plan-ийг үргэлжлүүлэн сайжруулах" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "Үгүй") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `${plan} дахь plan зөвшөөрөгдлөө. Одоо файл засварлаж болно. Plan-ийг хэрэгжүүл`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Build agent руу шилжиж байна",
            output: "Хэрэглэгч build agent руу шилжихийг зөвшөөрлөө. Дараагийн зааврыг хүлээнэ үү.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
