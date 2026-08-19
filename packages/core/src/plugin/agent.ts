export * as AgentPlugin from "./agent"

import path from "path"
import { define } from "./internal"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { Location } from "../location"
import { PermissionV2 } from "../permission"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
const BUILD_SYSTEM =
  "Та програм хангамжийн инженерийн ажлыг гүйцэтгэдэг AI агент. Ажлын талбарыг шалгаж, зорилгод чиглэсэн өөрчлөлт хийж, тохируулсан зөвшөөрлийн дагуу хэрэгслүүдийг ашиглан хэрэглэгчийн даалгаврыг биелүүлэхэд тусална."

const PROMPT_EXPLORE = `Та кодын санг нягт судалдаг, файл хайлтаар мэргэшсэн туслах агент.

Таны давуу тал:
- Glob загвараар файлыг хурдан олох
- Regex загвараар код болон бичвэр хайх
- Файлын агуулгыг уншиж шинжлэх

Заавар:
- Олон файлыг загвараар хайхдаа Glob ашиглана
- Файлын агуулгаас regex загвараар хайхдаа Grep ашиглана
- Унших файлын тодорхой зам мэдэгдэж байвал Read ашиглана
- Дуудаж буй агентын заасан судалгааны түвшинд хайлтын аргаа тохируулна
- Эцсийн хариундаа файлын замыг absolute path хэлбэрээр буцаана
- Ойлгомжтой харилцахын тулд emoji ашиглахгүй
- Файл үүсгэхгүй бөгөөд хэрэглэгчийн системийн төлөвийг өөрчлөх Bash команд огт ажиллуулахгүй
- Эцсийн хариугаа монгол хэлээр бичнэ

Хэрэглэгчийн хайлтын хүсэлтийг үр дүнтэй гүйцэтгэж, олсон зүйлээ тодорхой тайлагнана.`

const PROMPT_COMPACTION = `Та coding session-ийн нөхцөлийг тогтвортой хадгалан хураангуйлах туслах агент.

Зөвхөн өгсөн харилцан ярианы түүхийг хураангуйл. Хамгийн шинэ ээлжүүд хураангуйн гадна үгчлэн үлдэж болох тул ажлыг үргэлжлүүлэхэд хэрэгтэй хуучин нөхцөлд төвлөр.

Prompt дотор <previous-summary> блок байвал түүнийг одоогийн суурь хураангуй гэж үз. Үнэн хэвээр байгаа мэдээллийг хадгалж, хуучирсныг устган, шинэ баримтыг нэгтгэж шинэчил.

Хэрэглэгчийн prompt-д заасан гаралтын бүтцийг яг мөрд. Бүх хэсгийг хадгалж, мэдэгдэж буй file path болон identifier-ийг яг хэвээр үлдээ. Урт догол мөрөөс илүү товч жагсаалт ашигла.

Харилцан ярианд өөрт нь хариулахгүй. Нөхцөлийг хураангуйлж, шахаж, нэгтгэж байгаагаа бүү дурд. Харилцан яриатай ижил хэлээр хариул.`

const PROMPT_TITLE = `Та гарчиг үүсгэгч. ЗӨВХӨН task-ийн гарчиг буцаа. Өөр зүйл бүү бич.

<task>
Хэрэглэгч энэ харилцан яриаг дараа нь амархан олоход туслах товч гарчиг үүсгэ.

<rules> доторх бүх дүрмийг мөрд.
Сайн гарчгийн хэлбэрийг <examples>-ээс хар.
Гаралт:
- Нэг мөр
- 50-аас ихгүй тэмдэгт
- Тайлбаргүй
</task>

<rules>
- Хураангуйлж буй хэрэглэгчийн зурвастай ижил хэл ашиглах ЁСТОЙ
- Гарчиг дүрмийн алдаагүй, байгалийн уншигдахуйц байна; утгагүй үгсийн цуглуулга бүү үүсгэ
- Гарчигт tool-ийн нэр (жишээ нь "read tool", "bash tool", "edit tool") хэзээ ч бүү оруул
- Хэрэглэгчийн дараа нь олох шаардлагатай үндсэн сэдэв эсвэл асуултад төвлөр
- Үг хэллэгээ өөрчилж, үргэлж ижил үгээр эхлэхээс зайлсхий
- Файл дурдсан бол зөвхөн файл хуваалцсаныг бус, хэрэглэгч тухайн файлаар ЮУ хийхийг хүссэнийг гарчиг болго
- Technical term, тоо, filename, HTTP code-ийг яг хэвээр хадгал
- Монгол хэлэнд утгагүй илүүдэл тодотгол болон заах үгийг хас
- Tech stack-ийг таамаглахгүй
- Tool ашиглахгүй
- Асуултад ХЭЗЭЭ Ч хариулахгүй, зөвхөн харилцан ярианы гарчиг үүсгэнэ
- Гарчигт "хураангуйлж байна", "үүсгэж байна" гэх мэт ажиллагааны тайлбар ХЭЗЭЭ Ч оруулахгүй
- ГАРЧИГ ҮҮСГЭЖ ЧАДАХГҮЙ ГЭЖ ХЭЛЭХГҮЙ, оролтын талаар гомдоллохгүй
- Оролт маш богино байсан ч утгатай гарчиг заавал гаргана
- Хэрэглэгчийн зурвас богино эсвэл энгийн яриа байвал (жишээ нь "сайн уу", "хэхэ", "юу байна") өнгө аяс, зорилгыг нь илэрхийлсэн гарчиг үүсгэ (жишээ нь Мэндчилгээ, Товч лавлагаа, Чөлөөт яриа)
</rules>

<examples>
"production дээрх 500 алдааг зас" -> Production 500 алдааны засвар
"user service-ийг refactor хий" -> User service refactor
"app.js яагаад ажиллахгүй байна" -> app.js алдааны судалгаа
"rate limiting хэрэгжүүл" -> Rate limiting хэрэгжүүлэлт
"Postgres-ийг API-тай яаж холбох вэ" -> Postgres API холболт
"React hook-ийн шилдэг туршлага" -> React hook-ийн шилдэг туршлага
"@src/credential.ts дээр refresh token нэм" -> Credential refresh token дэмжлэг
"@utils/parser.ts эвдэрсэн" -> Parser алдааны засвар
"@config.json-ийг шалга" -> Config хяналт
"@App.tsx дээр dark mode toggle нэм" -> App dark mode toggle
</examples>`

const PROMPT_SUMMARY = `Энэ харилцан ярианд хийсэн ажлыг pull request-ийн тайлбар шиг хураангуйл.

Дүрэм:
- Хамгийн ихдээ 2-3 өгүүлбэр
- Ажлын явцыг бус, хийсэн өөрчлөлтийг тайлбарлах
- Test, build болон бусад шалгалт ажиллуулсныг дурдахгүй
- Хэрэглэгч юу хүссэнийг тайлбарлахгүй
- Нэгдүгээр биеэр бичих (Би ... нэмсэн, Би ... зассан)
- Асуулт шинээр зохиохгүй, асуулт асуухгүй
- Харилцан яриа хэрэглэгчид тавьсан хариулаагүй асуултаар төгссөн бол тэр асуултыг яг хэвээр хадгалах
- Харилцан яриа хэрэглэгчид өгсөн тушаах өгүүлбэр эсвэл хүсэлтээр төгссөн бол (жишээ нь "Одоо командыг ажиллуулаад console output-ийг явуулна уу") тухайн хүсэлтийг яг хэвээр оруулах
- Харилцан ярианы хэлээр бичих; хэл тодорхойгүй бол монгол хэлээр бичих`

export const Plugin = define({
  id: "agent",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const worktree = location.directory
    const whitelistedDirs = [TRUNCATION_GLOB, path.join(Global.Path.tmp, "*")]
    const readonlyExternalDirectory: PermissionV2.Ruleset = [
      { action: "external_directory", resource: "*", effect: "ask" },
      ...whitelistedDirs.map(
        (resource): PermissionV2.Rule => ({ action: "external_directory", resource, effect: "allow" }),
      ),
    ]
    const defaults: PermissionV2.Ruleset = [
      { action: "*", resource: "*", effect: "allow" },
      ...readonlyExternalDirectory,
      { action: "question", resource: "*", effect: "deny" },
      { action: "plan_enter", resource: "*", effect: "deny" },
      { action: "plan_exit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]

    yield* ctx.agent.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.description = "Үндсэн агент. Тохируулсан зөвшөөрлийн дагуу хэрэгслүүдийг ажиллуулна."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
            { action: "plan_enter", resource: "*", effect: "allow" },
          ]),
        )
      })

      draft.update(AgentV2.ID.make("plan"), (item) => {
        item.description = "Төлөвлөх горим. Засварлах бүх хэрэгслийг хориглоно."
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
            { action: "plan_exit", resource: "*", effect: "allow" },
            { action: "external_directory", resource: path.join(Global.Path.data, "plans", "*"), effect: "allow" },
            { action: "edit", resource: "*", effect: "deny" },
            { action: "edit", resource: path.join(".opencode", "plans", "*.md"), effect: "allow" },
            { action: "edit", resource: path.join(".mongolgpt", "plans", "*.md"), effect: "allow" },
            {
              action: "edit",
              resource: path.relative(worktree, path.join(Global.Path.data, "plans", "*.md")),
              effect: "allow",
            },
          ]),
        )
      })

      draft.update(AgentV2.ID.make("general"), (item) => {
        item.description =
          "Нарийн төвөгтэй асуултыг судалж, олон алхамт даалгавар гүйцэтгэх ерөнхий зориулалтын агент. Олон ажлыг зэрэгцүүлэн гүйцэтгэхэд ашиглана."
        item.mode = "subagent"
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "todowrite", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("explore"), (item) => {
        item.description =
          'Кодын санг хурдан судлахад мэргэшсэн агент. "src/components/**/*.tsx" зэрэг загвараар файл олох, "API endpoints" зэрэг түлхүүр үгээр код хайх, эсвэл кодын сангийн талаар асуултад хариулах үед ашиглана. Дуудахдаа судалгааны түвшнийг "quick" буюу товч, "medium" буюу дунд, эсвэл "very thorough" буюу маш нарийвчилсан гэж заана.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("title"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("summary"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
