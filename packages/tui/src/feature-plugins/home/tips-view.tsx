import type { TuiPluginApi } from "@mongolgpt/plugin/tui"
import { createMemo, For, type Accessor } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"

const themeCount = Object.keys(DEFAULT_THEMES).length

type TipPart = { text: string; highlight: boolean }
type TipShortcut = Accessor<string>
type Shortcuts = {
  agentCycle: TipShortcut
  childFirst: TipShortcut
  childNext: TipShortcut
  childPrevious: TipShortcut
  commandList: TipShortcut
  editorOpen: TipShortcut
  helpShow: TipShortcut
  inputClear: TipShortcut
  inputNewline: TipShortcut
  inputPaste: TipShortcut
  inputUndo: TipShortcut
  leader: TipShortcut
  messagesCopy: TipShortcut
  messagesFirst: TipShortcut
  messagesLast: TipShortcut
  messagesPageDown: TipShortcut
  messagesPageUp: TipShortcut
  messagesToggleConceal: TipShortcut
  modelCycleRecent: TipShortcut
  modelList: TipShortcut
  sessionExport: TipShortcut
  sessionInterrupt: TipShortcut
  sessionList: TipShortcut
  sessionNew: TipShortcut
  sessionParent: TipShortcut
  sessionPinToggle: TipShortcut
  sessionQuickSwitch1: TipShortcut
  sessionQuickSwitch9: TipShortcut
  sessionSidebarToggle: TipShortcut
  sessionTimeline: TipShortcut
  statusView: TipShortcut
  terminalSuspend: TipShortcut
  themeList: TipShortcut
}
type Tip = string | ((shortcuts: Shortcuts) => string | undefined)

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

const NO_MODELS_TIP = "{highlight}/connect{/highlight} ажиллуулж AI үйлчилгээ үзүүлэгч нэмээд код бичиж эхлээрэй"
const NO_MODELS_PARTS = parse(NO_MODELS_TIP)

function shortcutText(value: string) {
  return `{highlight}${value}{/highlight}`
}

function commandText(command: string, shortcut: string) {
  if (!shortcut) return shortcutText(command)
  return `${shortcutText(command)} эсвэл ${shortcutText(shortcut)}`
}

function press(shortcut: string, text: string) {
  if (!shortcut) return undefined
  return `${shortcutText(shortcut)} дарж ${text}`
}

function configShortcut(api: TuiPluginApi, command: string): TipShortcut {
  return () =>
    api.tuiConfig.keybinds
      .get(command)
      .map((binding) => api.keys.formatSequence(Array.from(api.keymap.parseKeySequence(binding.key))))
      .filter(Boolean)
      .join(", ")
}

export function Tips(props: { api: TuiPluginApi; connected?: boolean }) {
  const theme = useTheme().theme
  const tipOffset = Math.random()
  const shortcuts: Shortcuts = {
    agentCycle: useCommandShortcut("agent.cycle"),
    childFirst: configShortcut(props.api, "session.child.first"),
    childNext: configShortcut(props.api, "session.child.next"),
    childPrevious: configShortcut(props.api, "session.child.previous"),
    commandList: useCommandShortcut("command.palette.show"),
    editorOpen: useCommandShortcut("prompt.editor"),
    helpShow: useCommandShortcut("help.show"),
    inputClear: useCommandShortcut("prompt.clear"),
    inputNewline: useCommandShortcut("input.newline"),
    inputPaste: useCommandShortcut("prompt.paste"),
    inputUndo: useCommandShortcut("input.undo"),
    leader: configShortcut(props.api, "leader"),
    messagesCopy: configShortcut(props.api, "messages.copy"),
    messagesFirst: configShortcut(props.api, "session.first"),
    messagesLast: configShortcut(props.api, "session.last"),
    messagesPageDown: configShortcut(props.api, "session.page.down"),
    messagesPageUp: configShortcut(props.api, "session.page.up"),
    messagesToggleConceal: configShortcut(props.api, "session.toggle.conceal"),
    modelCycleRecent: useCommandShortcut("model.cycle_recent"),
    modelList: useCommandShortcut("model.list"),
    sessionExport: configShortcut(props.api, "session.export"),
    sessionInterrupt: configShortcut(props.api, "session.interrupt"),
    sessionList: useCommandShortcut("session.list"),
    sessionNew: useCommandShortcut("session.new"),
    sessionParent: configShortcut(props.api, "session.parent"),
    sessionPinToggle: configShortcut(props.api, "session.pin.toggle"),
    sessionQuickSwitch1: useCommandShortcut("session.quick_switch.1"),
    sessionQuickSwitch9: useCommandShortcut("session.quick_switch.9"),
    sessionSidebarToggle: configShortcut(props.api, "session.sidebar.toggle"),
    sessionTimeline: configShortcut(props.api, "session.timeline"),
    statusView: useCommandShortcut("mongolgpt.status"),
    terminalSuspend: useCommandShortcut("terminal.suspend"),
    themeList: useCommandShortcut("theme.switch"),
  }
  const tip = createMemo(() => {
    if (props.connected === false) return NO_MODELS_TIP
    const tips = [...TIPS, process.platform !== "win32" ? TERMINAL_SUSPEND_TIP : INPUT_UNDO_TIP].flatMap((item) => {
      const value = typeof item === "string" ? item : item(shortcuts)
      return value ? [value] : []
    })
    return tips[Math.floor(tipOffset * tips.length)] ?? NO_MODELS_TIP
  }, NO_MODELS_TIP)
  // Solid can expose a memo's initial value while a pure computation is pending.
  const parts = createMemo(() => {
    const value = tip()
    if (typeof value === "string") return parse(value)
    return NO_MODELS_PARTS
  }, NO_MODELS_PARTS)

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: theme.warning }}>
        ● Зөвлөмж{" "}
      </text>
      <text flexShrink={1} wrapMode="word">
        <For each={parts()}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}

const TIPS: Tip[] = [
  "Файл хайж хавсаргахын тулд {highlight}@{/highlight}-ийн араас файлын нэр бичнэ үү",
  "Бүрхүүлийн командыг шууд ажиллуулахын тулд мессежээ {highlight}!{/highlight}-ээр эхлүүлнэ үү (жишээ: {highlight}!ls -la{/highlight})",
  (shortcuts) => press(shortcuts.agentCycle(), "Бүтээх ба Төлөвлөх агентуудын хооронд шилжинэ"),
  "{highlight}/undo{/highlight} ашиглаж сүүлийн мессеж болон файлын өөрчлөлтийг буцаана",
  "{highlight}/redo{/highlight} ашиглаж өмнө буцаасан мессеж, файлын өөрчлөлтийг сэргээнэ",
  "{highlight}/share{/highlight} ажиллуулж өөрийн тохируулсан хуваалцах серверт ярианы холбоос үүсгэнэ",
  "Зураг эсвэл PDF файлыг терминал руу чирж тавиад контекст болгон нэмнэ",
  (shortcuts) => press(shortcuts.inputPaste(), "түр санах ой дахь зургаа хүсэлт рүү наана"),
  (shortcuts) => `${commandText("/editor", shortcuts.editorOpen())} ашиглаж гадаад засварлагч дээр мессеж бичнэ`,
  "{highlight}/init{/highlight} ажиллуулж кодын сан дээрээ тулгуурласан төслийн дүрмийг автоматаар үүсгэнэ",
  (shortcuts) => `${commandText("/models", shortcuts.modelList())} ашиглаж боломжтой AI загваруудыг харж, сольж болно`,
  (shortcuts) =>
    `${commandText("/themes", shortcuts.themeList())} ашиглаж суурилсан ${themeCount} өнгөний сэдвийн хооронд шилжинэ`,
  (shortcuts) => `${commandText("/new", shortcuts.sessionNew())} ашиглаж шинэ ярианы сешн эхлүүлнэ`,
  (shortcuts) => `${commandText("/sessions", shortcuts.sessionList())} ашиглаж сешнүүдийг жагсааж, хадаж, үргэлжлүүлнэ`,
  (shortcuts) => press(shortcuts.sessionPinToggle(), "сешний жагсаалт дотор сешнийг дээр нь байлгахаар хадна"),
  (shortcuts) =>
    shortcuts.sessionQuickSwitch1() && shortcuts.sessionQuickSwitch9()
      ? `Хадсан сешнүүдэд хурдан байрлал онооно; ${shortcutText(shortcuts.sessionQuickSwitch1())}-аас ${shortcutText(shortcuts.sessionQuickSwitch9())} хүртэл ашиглаж шилжинэ`
      : undefined,
  "{highlight}/compact{/highlight} ажиллуулж контекстийн хязгаарт ойртсон урт сешнийг хураангуйлна",
  (shortcuts) => `${commandText("/export", shortcuts.sessionExport())} ашиглаж яриаг Markdown болгон хадгална`,
  (shortcuts) => press(shortcuts.messagesCopy(), "туслахын сүүлийн мессежийг түр санах ой руу хуулна"),
  (shortcuts) => press(shortcuts.commandList(), "боломжтой бүх үйлдэл, командыг харна"),
  "{highlight}/connect{/highlight} ажиллуулж 75+ дэмжигдсэн LLM үйлчилгээ үзүүлэгчийн API түлхүүр нэмнэ",
  (shortcuts) => `Удирдах товч нь ${shortcutText(shortcuts.leader())}; хурдан үйлдэлд бусад товчтой хослуулна`,
  (shortcuts) => press(shortcuts.modelCycleRecent(), "сүүлд ашигласан загваруудын хооронд хурдан шилжинэ"),
  (shortcuts) => press(shortcuts.sessionSidebarToggle(), "сешн дотор хажуу самбарыг харуулах эсвэл нуух"),
  (shortcuts) =>
    shortcuts.messagesPageUp() && shortcuts.messagesPageDown()
      ? `${shortcutText(shortcuts.messagesPageUp())}/${shortcutText(shortcuts.messagesPageDown())} ашиглаж ярианы түүхээр шилжинэ`
      : undefined,
  (shortcuts) => press(shortcuts.messagesFirst(), "ярианы эхлэл рүү үсэрнэ"),
  (shortcuts) => press(shortcuts.messagesLast(), "хамгийн сүүлийн мессеж рүү үсэрнэ"),
  (shortcuts) => press(shortcuts.inputNewline(), "хүсэлт дотор шинэ мөр нэмнэ"),
  (shortcuts) => press(shortcuts.inputClear(), "бичиж байхдаа оролтын талбарыг цэвэрлэнэ"),
  (shortcuts) => press(shortcuts.sessionInterrupt(), "AI хариулж байхад нь зогсооно"),
  "Бодит өөрчлөлт хийхгүй зөвлөмж авахын тулд {highlight}Төлөвлөх{/highlight} агент руу шилжинэ",
  "Тусгай дэд агент дуудахдаа хүсэлт дотор {highlight}@agent-name{/highlight} ашиглана",
  (shortcuts) => {
    const items = [
      shortcuts.sessionParent(),
      shortcuts.childFirst(),
      shortcuts.childPrevious(),
      shortcuts.childNext(),
    ].filter(Boolean)
    if (!items.length) return undefined
    return `${items.map(shortcutText).join(" / ")} ашиглаж эцэг ба дэд сешнүүдийн хооронд шилжинэ`
  },
  "Серверийн тохиргоонд {highlight}mongolgpt.json{/highlight}, TUI тохиргоонд {highlight}tui.json{/highlight} үүсгэнэ",
  "Глобал тохиргоонд зориулж TUI тохиргоогоо {highlight}~/.config/mongolgpt/tui.json{/highlight} дотор байрлуулна",
  "Засварлагчийн автоматаар гүйцээх боломж авахын тулд тохиргоондоо {highlight}$schema{/highlight} нэмнэ",
  "Анхдагч загвараа тохируулахын тулд тохиргоо дотор {highlight}model{/highlight} тохируулна",
  "{highlight}tui.json{/highlight} доторх {highlight}keybinds{/highlight} хэсгээр дурын товчны холбоосыг дахин тодорхойлно",
  "Дурын товчны холбоосыг бүрэн унтраахын тулд {highlight}none{/highlight} болгоно",
  "Дотоод эсвэл алсын MCP серверүүдийг {highlight}mcp{/highlight} тохиргооны хэсэгт тохируулна",
  "Дахин ашиглах өөрийн хүсэлтийг тодорхойлохын тулд {highlight}.mongolgpt/commands/{/highlight} дотор {highlight}.md{/highlight} файл нэмнэ",
  "Динамик оролтод өөрийн команд дотор {highlight}$ARGUMENTS{/highlight}, {highlight}$1{/highlight}, {highlight}$2{/highlight} ашиглана",
  "Бүрхүүлийн гаралт оруулахдаа команд дотор урвуу хашилт ашиглана (жишээ: {highlight}`git status`{/highlight})",
  "Тусгай AI дүрд зориулж {highlight}.mongolgpt/agents/{/highlight} дотор {highlight}.md{/highlight} файл нэмнэ",
  "{highlight}edit{/highlight}, {highlight}bash{/highlight}, {highlight}webfetch{/highlight} хэрэгсэлд агент тус бүрийн зөвшөөрөл тохируулна",
  'Нарийвчилсан bash зөвшөөрөлд {highlight}"git *": "allow"{/highlight} гэх мэт загвар ашиглана',
  'Аюултай командыг хаахын тулд {highlight}"rm -rf *": "deny"{/highlight} тохируулна',
  'Push хийхээс өмнө зөвшөөрөл шаардах бол {highlight}"git push": "ask"{/highlight} тохируулна',
  'prettier, gofmt, ruff зэрэг бэлэн форматлагчийг асаахын тулд тохиргоонд {highlight}"formatter": true{/highlight} тохируулна',
  'Өөр тохиргооны давхаргаас асаасан форматлагчийг унтраахын тулд {highlight}"formatter": false{/highlight} тохируулна',
  "Файлын өргөтгөлтэй өөрийн форматлагчийн командуудыг тохиргоо дотор тодорхойлно",
  'Кодын шинжилгээнд суурилсан LSP серверүүдийг асаахын тулд тохиргоонд {highlight}"lsp": true{/highlight} тохируулна',
  "Шинэ LLM хэрэгсэл тодорхойлохын тулд {highlight}.mongolgpt/tools/{/highlight} дотор {highlight}.ts{/highlight} файл үүсгэнэ",
  "Хэрэгслийн тодорхойлолт нь Python, Go гэх мэт скрипт дуудаж чадна",
  "Үйл явдлын hook (дэгээ)-д зориулж {highlight}.mongolgpt/plugins/{/highlight} дотор {highlight}.ts{/highlight} файл нэмнэ",
  "Сешн дуусахад үйлдлийн системийн мэдэгдэл илгээхийн тулд нэмэлт ашиглана",
  "MongolGPT эмзэг файл уншихаас сэргийлэх залгаас үүсгэж болно",
  "Интерактив бус скриптэд {highlight}mongolgpt run{/highlight} ашиглана",
  "Сүүлийн сешнийг үргэлжлүүлэхийн тулд {highlight}mongolgpt --continue{/highlight} ашиглана",
  "CLI-гаар файл хавсаргахын тулд {highlight}mongolgpt run -f file.ts{/highlight} ашиглана",
  "Скриптэд машин унших боломжтой гаралт авахын тулд {highlight}--format json{/highlight} ашиглана",
  "MongolGPT-д дэлгэцгүй API хандалт авахын тулд {highlight}mongolgpt serve{/highlight} ажиллуулна",
  "Ажиллаж буй серверт холбогдохын тулд {highlight}mongolgpt run --attach{/highlight} ашиглана",
  "Сүүлийн хувилбар руу шинэчлэхийн тулд {highlight}mongolgpt upgrade{/highlight} ажиллуулна",
  "Тохируулсан бүх үйлчилгээ үзүүлэгчийг харахын тулд {highlight}mongolgpt auth list{/highlight} ажиллуулна",
  "Чиглүүлсэн агент үүсгэхийн тулд {highlight}mongolgpt agent create{/highlight} ажиллуулна",
  "AI үйлдэл өдөөхийн тулд GitHub issue/PR дотор {highlight}/mongolgpt{/highlight} ашиглана",
  "GitHub ажлын урсгал тохируулахын тулд {highlight}mongolgpt github install{/highlight} ажиллуулна",
  "Issue дээр {highlight}/mongolgpt fix this{/highlight} сэтгэгдэл бичиж PR автоматаар үүсгэнэ",
  "Зорилтот кодын хяналт хийхийн тулд PR-ийн кодын мөр дээр {highlight}/oc{/highlight} сэтгэгдэл бичнэ",
  'Терминалын өнгөтэй тааруулахын тулд {highlight}"theme": "system"{/highlight} ашиглана',
  "{highlight}.mongolgpt/themes/{/highlight} хавтас дотор JSON өнгөний сэдвийн файл үүсгэнэ",
  "Өнгөний сэдэв нь бараан, цайвар хоёр горимын хувилбар дэмждэг",
  "Өөрийн өнгөний сэдвийн JSON дотор xterm өнгөний 0-255 тоон код ашиглана",
  "Тохиргоо дотор орчны хувьсагч заахдаа {highlight}{env:VAR_NAME}{/highlight} бичлэг ашиглана",
  "Тохиргооны утгад файлын агуулга оруулахдаа {highlight}{file:path}{/highlight} ашиглана",
  "Нэмэлт дүрмийн файл ачаалахдаа тохиргоо дотор {highlight}instructions{/highlight} ашиглана",
  "Агентын {highlight}temperature{/highlight}-ийг 0.0 (төвлөрсөн)-оос 1.0 (бүтээлч) хүртэл тохируулна",
  "Нэг хүсэлт дээрх агентын давталтыг хязгаарлахын тулд {highlight}steps{/highlight} тохируулна",
  'Тодорхой хэрэгсэл унтраахын тулд {highlight}"tools": {"bash": false}{/highlight} тохируулна',
  'MCP серверээс ирсэн бүх хэрэгслийг унтраахын тулд {highlight}"mcp_*": false{/highlight} тохируулна',
  "Глобал хэрэгслийн тохиргоог агентын тохиргоо тус бүрээр дарж тохируулна",
  'Бүх сешнийг автоматаар share хийхийн тулд {highlight}"share": "auto"{/highlight} тохируулна',
  'Сешн share хийхийг бүрэн хориглохын тулд {highlight}"share": "disabled"{/highlight} тохируулна',
  "Нийтийн хандалтаас сешн хасахын тулд {highlight}/unshare{/highlight} ажиллуулна",
  "{highlight}doom_loop{/highlight} зөвшөөрөл нь төгсгөлгүй хэрэгслийн дуудлагын давталтаас хамгаална",
  "{highlight}external_directory{/highlight} зөвшөөрөл нь төслөөс гаднах файлуудыг хамгаална",
  "Тохиргооны асуудал оношлохын тулд {highlight}mongolgpt debug config{/highlight} ажиллуулна",
  "stderr дотор дэлгэрэнгүй бүртгэл харахын тулд {highlight}--print-logs{/highlight} туг ашиглана",
  (shortcuts) => `${commandText("/timeline", shortcuts.sessionTimeline())} ашиглаж тодорхой мессеж рүү үсэрнэ`,
  (shortcuts) => press(shortcuts.messagesToggleConceal(), "мессеж доторх кодын блокийн харагдацыг асааж/унтраана"),
  (shortcuts) => `${commandText("/status", shortcuts.statusView())} ашиглаж системийн төлөвийн мэдээлэл харна`,
  "Зөөлөн macOS маягийн гүйлгэхийн тулд {highlight}tui.json{/highlight} дотор {highlight}scroll_acceleration{/highlight} асаана",
  (shortcuts) =>
    shortcuts.commandList()
      ? `Командын цэсээр чат дахь хэрэглэгчийн нэрийн харагдацыг асааж/унтраана (${shortcutText(shortcuts.commandList())})`
      : "Командын цэсээр чат дахь хэрэглэгчийн нэрийн харагдацыг асааж/унтраана",
  "Контейнер дотор ашиглахын тулд {highlight}docker run -it --rm ghcr.io/sergei10a-rgb/mongolgpt{/highlight} ажиллуулна",
  "MongolGPT бүртгэл эсвэл өөрийн үйлчилгээ үзүүлэгчээ холбохын тулд {highlight}/connect{/highlight} ашиглана",
  "Багаараа хуваалцахын тулд төслийн {highlight}AGENTS.md{/highlight} файлыг Git-д commit хийнэ",
  "Commit хийгдээгүй өөрчлөлт, салбар эсвэл PR-ийг хянахын тулд {highlight}/review{/highlight} ашиглана",
  (shortcuts) => `${commandText("/help", shortcuts.helpShow())} ашиглаж тусламжийн цонх харуулна`,
  "Одоогийн сешний нэр солихын тулд {highlight}/rename{/highlight} ашиглана",
]

const INPUT_UNDO_TIP: Tip = (shortcuts) => press(shortcuts.inputUndo(), "хүсэлт доторх өөрчлөлтийг буцаана")
const TERMINAL_SUSPEND_TIP: Tip = (shortcuts) =>
  press(shortcuts.terminalSuspend(), "терминалыг түр зогсоож бүрхүүл рүү буцна")
