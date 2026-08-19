export * as QuestionV1 from "./question"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { statics } from "../schema"
import { SessionID } from "../session-id"
import { SessionV1 } from "./session"

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("QuestionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "que_" + ascending()) })),
)

export const Option = Schema.Struct({
  label: Schema.String.annotate({ description: "Харуулах товч текст (1-5 үгтэй)" }),
  description: Schema.String.annotate({ description: "Сонголтын тайлбар" }),
}).annotate({ identifier: "QuestionOption" })

const base = {
  question: Schema.String.annotate({ description: "Бүрэн хэлбэрийн асуулт" }),
  header: Schema.String.annotate({ description: "Маш товч гарчиг (30 тэмдэгтээс ихгүй)" }),
  options: Schema.Array(Option).annotate({ description: "Боломжит сонголтууд" }),
  multiple: Schema.optional(Schema.Boolean).annotate({ description: "Олон сонголт сонгохыг зөвшөөрөх" }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({
    description: "Тусгай хариулт бичихийг зөвшөөрөх (анхдагч утга: true)",
  }),
}).annotate({ identifier: "QuestionInfo" })
export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export const Tool = Schema.Struct({ messageID: SessionV1.MessageID, callID: Schema.String }).annotate({
  identifier: "QuestionTool",
})
export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({ description: "Асуух асуултууд" }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionAnswer" })
export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "Асуултын дарааллын дагуух хэрэглэгчийн хариултууд (хариулт бүр сонгосон шошгын массив байна)",
  }),
}).annotate({ identifier: "QuestionReply" })
export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: ID,
  answers: Schema.Array(Answer),
}).annotate({
  identifier: "QuestionReplied",
})
export const Rejected = Schema.Struct({ sessionID: SessionID, requestID: ID }).annotate({
  identifier: "QuestionRejected",
})

const Asked = define({ type: "question.asked", schema: Request.fields })
const RepliedEvent = define({ type: "question.replied", schema: Replied.fields })
const RejectedEvent = define({ type: "question.rejected", schema: Rejected.fields })
export const Event = {
  Asked,
  Replied: RepliedEvent,
  Rejected: RejectedEvent,
  Definitions: inventory(Asked, RepliedEvent, RejectedEvent),
}
