export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@mongolgpt/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `<template> дотор үзүүлсэн Markdown бүтцийг яг хэвээр нь гаргаж, хэсгүүдийн дарааллыг бүү өөрчил. Хариултдаа <template> тэмдэглэгээг бүү оруул.
<template>
## Зорилго
- [ажлын нэг өгүүлбэртэй хураангуй]

## Хязгаарлалт ба сонголт
- [хэрэглэгчийн хязгаарлалт, сонголт, шаардлага эсвэл "(байхгүй)"]

## Явц
### Дууссан
- [дууссан ажил эсвэл "(байхгүй)"]

### Хийгдэж буй
- [одоогийн ажил эсвэл "(байхгүй)"]

### Саатсан
- [саад болсон зүйлс эсвэл "(байхгүй)"]

## Гол шийдвэрүүд
- [шийдвэр болон шалтгаан эсвэл "(байхгүй)"]

## Дараагийн алхмууд
- [дарааллаар хийх дараагийн ажлууд эсвэл "(байхгүй)"]

## Чухал контекст
- [чухал техникийн баримт, алдаа, нээлттэй асуулт эсвэл "(байхгүй)"]

## Холбогдох файлууд
- [файл эсвэл хавтасны зам: яагаад хамаатай эсвэл "(байхгүй)"]
</template>

Дүрэм:
- Хоосон байсан ч бүх хэсгийг хадгал.
- Урт догол мөрийн оронд товч жагсаалт ашигла.
- Мэдэгдэж буй файлын зам, команд, алдааны мөр болон танигчийг яг хэвээр нь хадгал.
- Хураангуй үүсгэсэн үйл явц эсвэл контекстийг хураангуйлсан талаар бүү дурд.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[богиносгов]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Хавсралт ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Хавсралт ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[Хэрэглэгч]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Туслах]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Туслахын үндэслэл]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Туслахын хэрэгслийн дуудлага]: ${part.name}(${input})`,
            `[Хэрэгслийн үр дүн]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [
            `[Туслахын хэрэгслийн дуудлага]: ${part.name}(${input})`,
            `[Хэрэгслийн алдаа]: ${part.state.error.message}`,
          ]
        return [`[Туслахын хэрэгслийн дуудлага]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[Системийн шинэчлэл]: ${message.text}`
  if (message.type === "synthetic") return `[Үүсгэсэн контекст]: ${message.text}`
  if (message.type === "shell") return `[Терминал]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].slice(0, -remaining)
        splitSuffix = conversation[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...conversation.slice(0, split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split)].filter(Boolean).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Доорх суурь хураангуйг дээрх харилцан ярианы түүхээр шинэчил.\nҮнэн хэвээр байгаа мэдээллийг хадгалж, хуучирсныг устган, шинэ баримтыг нэгтгэ.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Харилцан ярианы түүхээс шинэ суурь хураангуй үүсгэ.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
