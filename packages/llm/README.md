# @mongolgpt/llm

`mongolgpt`-ийн schema-д тулгуурласан LLM цөм. Төрөлжүүлсэн хүсэлт, хариу, event болон хэрэгслийн нэг нэгдсэн хэлтэй. Үйлчилгээ үзүүлэгч бүрийн онцлог ялгааг дуудагч кодод бус, тохируулагчид тусгаарлана.

```ts
import { Effect } from "effect"
import { LLM, LLMClient } from "@mongolgpt/llm"
import { OpenAI } from "@mongolgpt/llm/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")

const request = LLM.request({
  model,
  system: "Товч хариул.",
  prompt: "Нэг богино өгүүлбэрээр мэндчил.",
  generation: { maxTokens: 40 },
})

const program = Effect.gen(function* () {
  const response = yield* LLMClient.generate(request)
  console.log(response.text)
})
```

Хэсэгчлэн ирэх `LLMEvent` авах бол `generate`-ийн оронд `LLMClient.stream(request)`-ийг ажиллуул. Event урсгал нь үйлчилгээ үзүүлэгчээс үл хамаарах тул OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, Bedrock Converse болон OpenAI-тай нийцтэй ямар ч байршуулалтад ижил хэлбэртэй байна.

## Нийтэд нээлттэй API

- **`LLM.request({...})`** — үйлчилгээ үзүүлэгчээс үл хамаарах `LLMRequest` үүсгэнэ. Нэгдсэн Schema class руу жигдрүүлэх, хэрэглэхэд эвтэй оролтуудыг (`system: string`, `prompt: string`) хүлээн авна.
- **`LLM.generate` / `LLM.stream`** — нэг импортоор ашиглахын тулд `LLMClient`-аас дахин экспортолсон.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — нэгдсэн schema загварын зурвас байгуулагчид.
- **`Model.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — нэгдсэн schema загварын модель болон хэрэгсэлтэй холбоотой байгуулагчид.
- **`LLMClient.prepare(request)`** — хүсэлтийг илгээлгүйгээр протоколын body байгуулах, баталгаажуулах болон HTTP-д бэлдэх үе шатаар хөрвүүлнэ. Ажиглан шалгах болон туршихад ашиглана.
- **`LLMEvent.is.*`** — урсгал шүүх төрөлжүүлсэн хамгаалагчид (`is.textDelta`, `is.toolCall`, `is.finish`, …).

## Түр санах ой

Prompt-ыг түр санах боломж **анхнаасаа асаалттай**. Дуудагч тал `cache: "none"` гэж унтраагаагүй бол бүх `LLMRequest` `cache: "auto"` болно. Протокол бүр `CacheHint`-ийг дамжуулалтын өөрийн хэлбэрт хөрвүүлнэ. Anthropic дээр `cache_control`, Bedrock дээр `cachePoint` ашиглана. OpenAI болон Gemini сервер талдаа далд түр хадгалдаг тул доторх тэмдэглэгээ шаардлагагүй, тэнд `auto` нэмэлт үйлдэл хийхгүй.

### Автомат байршуулалт

`"auto"` нь гурван зааг тавина: хамгийн сүүлийн хэрэгслийн тодорхойлолт, системийн хамгийн сүүлийн хэсэг, хэрэглэгчийн хамгийн сүүлийн зурвас. Энд хэрэглэгчийн хамгийн сүүлийн зурвасын зааг хамгийн чухал. Хэрэгсэл ашиглах давталтад хэрэглэгчийн нэг ээлж assistant болон хэрэгслийн олон нааш цааш дамжуулалт болж тэлэх бөгөөд бүгд ижил эхлэлийг хуваалцана. Тэр заагт түр хадгалснаар нэг ээлж доторх API дуудлага бүр хадгалсан үр дүнг ашиглах боломжтой.

Энэ анхны тохиргоог өртгийн тооцоо зөвтгөнө. Anthropic-ийн 5 минутын түр санах ойд бичих үнэ суурь үнийн 1.25 дахин, унших үнэ 0.1 дахин тул таван минутын дотор нэг удаа дахин ашиглахад л хэмнэлттэй. Загвар тус бүрийн түр хадгалж болох хамгийн бага token-ы босгоос доогуур нэг удаагийн гүйцээлт дамжуулалтын түвшинд нэмэлт үйлдэл хийхгүй тул хамгийн муу тохиолдол ч хоргүй.

### Унтраах

```ts
LLM.request({
  model,
  system,
  prompt: "нэг удаагийн асуулт",
  cache: "none",
})
```

### Нарийвчилсан бодлого

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic/Bedrock; else 5m
}
```

### Гараар өгсөн дохио

Текст, систем, хэрэгсэл эсвэл хэрэгслийн үр дүнгийн аль ч хэсэгт дотор нь өгсөн `CacheHint` автомат байршуулалтыг дарна. Автомат бодлого гараар өгсөн дохиог хадгалж, зөвхөн дутуу хэсгийг нөхнө.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "тогтвортой системийн prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Үйлчилгээ үзүүлэгчийн ажиллагаа

| Протокол                | `cache: "auto"`                                                                |
| ----------------------- | ------------------------------------------------------------------------------ |
| Anthropic Messages      | Дээд тал нь 3 `cache_control` тэмдэглэгээ гаргана, нийт заагийн дээд хязгаар 4 |
| Bedrock Converse        | Дээд тал нь 3 `cachePoint` блок гаргана, нийт заагийн дээд хязгаар 4           |
| OpenAI Chat / Responses | 1024 token-оос дээш сервер талдаа далд түр хадгалдаг тул нэмэлт үйлдэл хийхгүй |
| Gemini                  | 2.5+-д сервер талдаа далд хадгална; ил `CachedContent` нь тусдаа урсгалтай     |

Жигдрүүлсэн түр санах ойн хэрэглээг бүх үйлчилгээ үзүүлэгч дээр `response.usage.cacheReadInputTokens` болон `cacheWriteInputTokens`-оос уншина.

## Үйлчилгээ үзүүлэгчид

Үйлчилгээ үзүүлэгчийн facade эхлээд endpoint, нэвтрэлт болон байршуулалтын мэдээллийг тохируулна. Дараа нь зөвхөн загвар эсвэл байршуулалтын ID авдаг загвар сонгогчийг гаргана. Сонгосон загвар ажиллах үед ашиглах чиглэлийн утгаа өөртөө агуулна.

```ts
import { OpenAI, CloudflareAIGateway } from "@mongolgpt/llm/providers"

const openai = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")
const gateway = CloudflareAIGateway.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN,
}).model("workers-ai/@cf/meta/llama-3.1-8b-instruct")
```

Багтсан үйлчилгээ үзүүлэгчид: OpenAI, Anthropic, Google (Gemini), Amazon Bedrock, Azure OpenAI, Cloudflare AI Gateway, Cloudflare Workers AI, GitHub Copilot, OpenRouter, xAI. Мөн DeepSeek, Cerebras, Groq, Fireworks, Together зэрэгт зориулсан ерөнхий OpenAI-тай нийцтэй туслахууд багтана.

## Үйлчилгээ үзүүлэгчийн тохиргоо ба HTTP давхар тохируулга

Тогтвортой байдлын дарааллаар гурван нөөц гарц бий:

1. **`generation`** — орчин хооронд зөөврийн тохируулгууд (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`providerOptions: { <provider>: {...} }`** — гадаад API дээр төрөлжүүлсэн, үйлчилгээ үзүүлэгчид тусгайлсан тохируулгууд (OpenAI `promptCacheKey`, Anthropic `thinking`, Gemini `thinkingConfig`, OpenRouter routing).
3. **`http: { body, headers, query }`** — эцсийн HTTP хүсэлтэд нэгтгэх, цуваа болгох боломжтой давхар тохируулга. Тогтвортой төрөлжүүлсэн зам хараахан байхгүй үед л хэрэглэнэ.

Чиглэл болон үйлчилгээ үзүүлэгчийн анхны утгыг хүсэлтийн түвшний утга чиглэл тус бүрээр дарж өөрчилнө.

## Чиглэлүүд

Шинэ загвар эсвэл байршуулалт нэмэхэд ихэвчлэн `Route.make({ protocol, endpoint, auth, framing, ... })` ашигласан 5-15 мөр хангалттай. Чиглэл нь endpoint, нэвтрэлт болон frame-ийн хэлбэрийг хариуцна. Протокол нь body байгуулах болон урсгалыг тайлах ажлыг хариуцна. Дамжуулагчид нь хөрвүүлэх үед чиглэлийн endpoint болон нэвтрэлтийг хүлээн авдаг, дахин ашиглаж болох оролт гаралтын загварууд юм. Боломж болон каталогийн metadata энэ доод түвшний багцаас гадуур байрлана. Дэмжихгүй хүсэлтийн хэлбэр протоколыг буулгах үед алдаа өгнө. Архитектурын дэлгэрэнгүйг `AGENTS.md`-ээс хар.

## Effect

Энэ багц Effect дээр суурилсан. Нийтэд гарсан аргууд `Effect` эсвэл `Stream` буцаана. Ажиллах үеийн дамжуулалтад `LLMClient.layer`-ийг өгч, ашиглах чиглэлийнхээ үйлчилгээ үзүүлэгч болон протоколын модулийг импортолно. `example/tutorial.ts` дахь жишээ нь шууд ажиллуулж болох алхамчилсан заавар юм.

## Мөн үз

- `AGENTS.md` — архитектур, чиглэл байгуулах арга, хувь нэмэр оруулагчийн заавар
- `example/tutorial.ts` — эхнээс төгсгөл хүртэл ажиллуулж болох заавар
- `test/provider/*.test.ts` — fixture-д тулгуурласан протоколын шалгалтууд; `*.recorded.test.ts` файлууд бодит бичлэгийг хамарна
