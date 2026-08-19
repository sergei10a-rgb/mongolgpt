<!--
  Суурилагдсан чадвар. Нэр болон тайлбарыг кодод бүртгэсэн:
  packages/core/src/plugin/skill.ts
  мөн CUSTOMIZE_MONGOLGPT_SKILL_DESCRIPTION. Доорх хэсэг нь чадварын
  агуулга болно.
-->

# MongolGPT-г тохируулах

MongolGPT өөрийн тохиргоог хатуу шалгадаг бөгөөд аль нэг талбар буруу байвал
эхлүүлэхээс татгалзана. Доорх хэлбэрүүд нийтлэг хэрэглээг хамардаг боловч
**эх сурвалж биш, хураангуй** юм.

## Бүрэн схемийн лавлагаа

Бүх тохиргооны сонголтын эрх бүхий жагсаалт — талбарын төрөл, сонголтын утгууд, анхдагч утга,
тайлбарын хамт — нийтлэгдсэн JSON схемд байна:

**<https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/packages/web/public/config.json>**

Хэрэв энэ чадварт талбар тайлбарлагдаагүй эсвэл тохиргоо бичихийн өмнө яг хэлбэрийг
баталгаажуулах шаардлагатай бол таамаглахын оронд **тэр URL-г авч схемийг
шууд унш**. MongolGPT буруу тохиргоо дээр шууд зогсдог тул буруу хэлбэрийн өртөг
нь эхлэлт эвдрэх явдал юм.

Мөн `mongolgpt.json` бүр хэрэглэгчийн засварлагч бичиж байх үед алдааг илрүүлэхийн
тулд дараахыг зарлах ёстой:
`"$schema": "https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/packages/web/public/config.json"`.

## Өөрчлөлт хэрэгжүүлэх

Тохиргоо нь MongolGPT эхлэхэд нэг удаа ачаалагддаг бөгөөд шууд дахин ачаалагдахгүй.
`mongolgpt.json`, агентын файл, чадвар, нэмэлт эсвэл тохиргоо ачаалах үеийн өөр файлд өөрчлөлт
хадгалсны дараа **өөрчлөлт хэрэгжихийн тулд MongolGPT-г бүрэн хааж дахин
эхлүүлэхийг хэрэглэгчид хэл**. Ажиллаж буй харилцаа нь аль хэдийн ачаалсан
тохиргоогоо үргэлжлүүлэн ашиглана.

## Файлууд хаана байрлах вэ

| Хамрах хүрээ | Зам |
| --- | --- |
| Төслийн тохиргоо | `./mongolgpt.json`, `./mongolgpt.jsonc`, эсвэл `.mongolgpt/mongolgpt.json` (MongolGPT одоогийн ажлын хавтсаас ажлын модны үндэс хүртэл дээш хайна) |
| Ерөнхий тохиргоо | `~/.config/mongolgpt/mongolgpt.json` ( `~/.mongolgpt/` БИШ) |
| Төслийн агентууд | `.mongolgpt/agent/<name>.md` эсвэл `.mongolgpt/agents/<name>.md` |
| Ерөнхий агентууд | `~/.config/mongolgpt/agent(s)/<name>.md` |
| Төслийн командууд | `.mongolgpt/command/<name>.md` эсвэл `.mongolgpt/commands/<name>.md` |
| Ерөнхий командууд | `~/.config/mongolgpt/command(s)/<name>.md` |
| Төслийн чадварууд | `.mongolgpt/skill(s)/<name>/SKILL.md` |
| Ерөнхий чадварууд | `~/.config/mongolgpt/skill(s)/<name>/SKILL.md` |
| Гаднын чадварууд (автоматаар ачаалагдана) | `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md` |

Хамрах хүрээ бүрийн тохиргоог гүн нийлүүлнэ. Төслийн тохиргоо ерөнхий тохиргоог дарна.
`mongolgpt.json`-ийн танигдаагүй дээд түвшний түлхүүрүүд
`ConfigInvalidError`-оор татгалзагдана.

## mongolgpt.json

Бүх талбар заавал биш.

```json
{
  "$schema": "https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/packages/web/public/config.json",
  "username": "string",
  "model": "provider/model-id",
  "small_model": "provider/model-id",
  "default_agent": "agent-name",
  "shell": "/bin/zsh",
  "logLevel": "DEBUG" | "INFO" | "WARN" | "ERROR",
  "share": "manual" | "auto" | "disabled",
  "autoupdate": true | false | "notify",
  "snapshot": true,
  "instructions": ["AGENTS.md", "docs/style.md"],

  "skills": {
    "paths": [".mongolgpt/skills", "/abs/path/to/skills"],
    "urls": ["https://example.com/.well-known/skills/"]
  },

  "references": {
    "docs": {
      "path": "../docs",
      "description": "Бүтээгдэхүүний үйлдэл болон баримт бичгийн хэвшилд ашиглана"
    },
    "sdk": {
      "repository": "owner/sdk",
      "branch": "main",
      "description": "SDK-ийн хэрэгжүүлэлтийн дэлгэрэнгүйд ашиглана",
      "hidden": true
    }
  },

  "agent": {
    "my-agent": {
      "model": "anthropic/claude-sonnet-4-6",
      "mode": "subagent",
      "description": "...",
      "permission": { "edit": "deny" }
    }
  },

  "command": {
    "deploy": { "description": "...", "template": "..." }
  },

  "provider": {
    "anthropic": { "options": { "apiKey": "..." } }
  },
  "disabled_providers": ["openai"],
  "enabled_providers": ["anthropic"],

  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "env": {}
    },
    "remote-thing": {
      "type": "remote",
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." }
    }
  },

  "plugin": [
    "mongolgpt-gemini-auth",
    "mongolgpt-foo@1.2.3",
    "./local-plugin.ts",
    ["mongolgpt-bar", { "option": "value" }]
  ],

  "permission": {
    "edit": "deny",
    "bash": { "git *": "allow", "*": "ask" }
  },

  "formatter": false,
  "lsp": false,

  "experimental": {
    "primary_tools": ["edit"],
    "mcp_timeout": 30000
  },

  "tool_output": { "max_lines": 200, "max_bytes": 8192 },

  "compaction": { "auto": true, "tail_turns": 15 }
}
```

Хэлбэрийн чухал тэмдэглэл:

- `model` үргэлж үйлчилгээ үзүүлэгчийн угтвартай: `"anthropic/claude-sonnet-4-6"`.
- `skills` нь `paths` болон/эсвэл `urls`-тай түлхүүр-утгын бүтэц болохоос жагсаалт биш.
- `references` нь товчилсон нэрээр түлхүүрлэсэн бүтэц. Утга бүр дотоод зам, Git репо эсвэл тэмдэгт мөрийн товчилсон хэлбэр байна.
- `agent` нь агентын нэрээр түлхүүрлэсэн бүтэц болохоос жагсаалт биш.
- `command` нь командын нэрээр түлхүүрлэсэн бүтэц болохоос жагсаалт биш.
- `plugin` нь тэмдэгт мөр эсвэл `[name, options]` хослолуудын жагсаалт болохоос түлхүүр-утгын бүтэц биш.
- `mcp[name].command` нь хэзээ ч ганц тэмдэгт мөр биш, тэмдэгт мөрүүдийн жагсаалт байна. `type` заавал хэрэгтэй.
- `permission` нь тэмдэгт мөрөөр өгсөн үйлдэл эсвэл хэрэгслийн нэрээр түлхүүрлэсэн бүтэц байна.

## Чадварууд

MongolGPT-ийн чадвар ачаалагч чадварын хавтас доторх `**/SKILL.md`-г хайна.
Файлын нэр яг `SKILL.md` байх бөгөөд чадварын нэртэй өөрийн хавтас дотор байрлана:

```
.mongolgpt/skills/my-skill/SKILL.md
```

Толгойн мета мэдээлэл:

```markdown
---
name: my-skill
description: Энэ чадвар юу хийдэг болон хэзээ идэвхжүүлэхийг хамарсан нэг өгүүлбэр. Хэрэглэгчийн хэлэх магадлалтай бодит түлхүүр үг эсвэл файлын нэрийг эхэнд байрлуул.
---

# Миний чадвар

(Markdown хэлбэрийн чадварын үндсэн агуулга: заавар, жишээ, лавлагаа)
```

- `name` заавал байна, жижиг үсэг ба зураасаар холбогдсон, 64 тэмдэгтээс ихгүй бөгөөд хавтасны нэртэй таарна.
- `description` нь практик дээр заавал шаардлагатай: тайлбаргүй чадвар шүүгдэж, загварт хэзээ ч харагдахгүй. Чадвар юу хийдэг, хэзээ ашиглахыг хоёуланг нь бич. Гуравдагч биеэр бич ("Би ...-д тусална" биш, "... үед ашигла"). Хэрэглэгчийн хэлэх магадлалтай бодит өдөөгч түлхүүр үг болон файлын нэрийг эхэнд байрлуул; ойролцоо сэдэв дээр дуугүй байх ёстой бол "ЗӨВХӨН ... үед ашигла" гэж хязгаарла.
- Заавал биш: `license`, `compatibility`, `metadata` (тэмдэгт мөрийн түлхүүр-утгын зураглал).

Анхдагч бус байрлалаас чадвар бүртгэхийн тулд `skills.paths` ( `**/SKILL.md`-г дэд хавтас бүрээс хайна) болон `skills.urls` (URL бүр чадварын жагсаалт өгнө)-г ашигла.

## Лавлагаанууд

Лавлагаа нь идэвхтэй төслөөс гаднах дотоод хавтас болон Git репог
дэмжих орчин болгон ашиглах боломж олгоно. `@` автоматаар нөхөхөд ашиглах
товчилсон нэрээр түлхүүрлэн `references` дотор тохируул:

```json
{
  "references": {
    "docs": {
      "path": "../product-docs",
      "description": "Бүтээгдэхүүний үйлдэл болон нэр томьёонд ашиглана"
    },
    "effect": {
      "repository": "Effect-TS/effect",
      "branch": "main",
      "description": "Effect-ийн хэрэгжүүлэлтийн дэлгэрэнгүйд ашиглана"
    }
  }
}
```

Дотоод `path` нь зарласан тохиргооны файлтай харьцангуй, бүрэн эсвэл `~/`-оор эхэлсэн зам байж болно.
Git `repository` нь Git URL, хост/замын лавлагаа болон GitHub-ийн
`owner/repo` товчилсон хэлбэрийг зөвшөөрнө; `branch` заавал биш. Хоёр хэлбэрт
`description`, `hidden` заавал биш.

- Зөвхөн `description`-тай лавлагааг агентын системийн орчинд зарлана.
- `hidden: true` нь лавлагааг зөвхөн TUI-ийн `@` автоматаар нөхөхөөс нуух бөгөөд агент болон шууд замаар ашиглах боломжтой хэвээр.
- Лавлагааны хавтас нь гаднын хавтасны хязгаараар автоматаар зөвшөөрөгдөнө; ердийн унших/засах/хэрэгсэл ашиглах зөвшөөрөл хэвээр үйлчилнэ.
- Тэмдэгт мөрийн товчилсон хэлбэр дэмжинэ: дотоод замд `"docs": "../docs"`, Git репод `"effect": "Effect-TS/effect"` ашигла.

## Агентууд

Агент тодорхойлох хоёр арга бий. Энгийн бус зүйлд файл хэлбэрийг ашигла.

### Мөр дотор (`mongolgpt.json`-д)

```json
{
  "agent": {
    "my-reviewer": {
      "description": "PR-үүдийг хэв маягийн зөрчлийн хувьд шалгана.",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "permission": { "edit": "deny", "bash": "ask" },
      "prompt": "Та PR-ийг хатуу шалгадаг хянагч."
    }
  }
}
```

### Файл хэлбэрээр

```
.mongolgpt/agent/my-reviewer.md      OR     .mongolgpt/agents/my-reviewer.md
```

```markdown
---
description: PR-үүдийг хэв маягийн зөрчлийн хувьд шалгана.
mode: subagent
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash: ask
---

Та PR-ийг хатуу шалгадаг хянагч. Гол анхаарлаа ...-д төвлөрүүл.
```

Файлын үндсэн агуулга нь агентын `prompt` болно. Толгойн мета мэдээлэлд `prompt:`-ийг давхар бүү тавь.

`mode` нь `"primary"`, `"subagent"`, `"all"`-ын нэг байна.

Толгойн мета мэдээллийн дээд түвшинд зөвшөөрөгдөх талбарууд: `name`, `model`,
`variant`, `description`, `mode`, `hidden`, `color`, `steps`, `options`,
`permission`, `disable`, `temperature`, `top_p`. Танигдаагүй талбар бүрийг
чимээгүйгээр `options` дотор оруулна.

Суурилагдсан агентыг идэвхгүй болгохдоо `agent: { build: { disable: true } }`
эсвэл файлын толгойн мета мэдээлэлд `disable: true` тавь.

`default_agent` нь нуугдсан биш, үндсэн горимын агент руу заах ёстой.

### Суурилагдсан агентууд

MongolGPT нь `build`, `plan`, `general`, `explore`-г нийлүүлж өгнө. Дотооддоо
нуусан агентууд: `compaction`, `title`, `summary`. Суурилагдсан агентын талбарыг
өөрчлөхдөө `agent: { <name>: { ... } }` дотор ижил түлхүүрийг тодорхойл.

## Командууд

MongolGPT-ийн команд ачаалагч командын хавтас доторх `**/*.md`-г хайна.
Файлын нэр командын нэртэй адил бөгөөд `command` хавтасны шууд дотор байна:

```
.mongolgpt/command/deploy.md
```

Толгойн мета мэдээлэл:

```markdown
---
description: Команд юу хийдгийг тайлбарласан нэг өгүүлбэр.
agent: build
model: anthropic/claude-sonnet-4-6
---

(Markdown хэлбэрийн командын үндсэн агуулга: MongolGPT-ийн ажиллуулах заавар; хэрэглэгчийн оролтыг авахын тулд $ARGUMENTS ашиглана)
```

- `template` нь толгойн мета мэдээллийн доорх бүх зүйл буюу команд дуудагдахад MongolGPT ажиллуулах заавар бөгөөд заавал байна. Толгойн мета мэдээлэлд `template:` түлхүүрийг давхар бүү тавь.
- `$ARGUMENTS` нь командын дараа хэрэглэгчийн бичсэн бүх зүйлээр солигдоно; `$1`, `$2`, … нь байрлалын тус тусын аргументыг авна.
- Заавал биш: `description`, `agent`, `model`, `variant`, `subtask`.

## Нэмэлтүүд

`plugin:` нь жагсаалт. Бичлэг бүр дараахын аль нэг байна:

```json
"plugin": [
  "mongolgpt-gemini-auth",            // npm-ийн тодорхойлолт, хамгийн сүүлийн хувилбар
  "mongolgpt-foo@1.2.3",              // npm-ийн тодорхойлолт, тогтоосон хувилбар
  "./local-plugin.ts",               // зарласан тохиргоотой харьцангуй файлын зам
  "file:///abs/path/plugin.js",      // файлын URL
  ["mongolgpt-bar", { "key": "val" }] // сонголттой tuple хэлбэр
]
```

Автоматаар илрүүлэх нэмэлт (тохиргоонд бичлэг шаардлагагүй): `.mongolgpt/plugin/` эсвэл
`.mongolgpt/plugins/` доторх дурын `*.ts` эсвэл `*.js` файл.

Нэмэлтийн модуль нь `default` экспорт эсвэл дурын нэрлэсэн экспортоор
`Plugin = (input: PluginInput, options?) => Promise<Hooks>` төрлийн функцийг гаргана. Экспорт нь энгийн
түлхүүр-утгын тогтмол бүтэц биш функц байх бөгөөд бүртгэх зүйлгүй бол `{}` буцаана.

```ts
import type { Plugin } from "@mongolgpt/plugin"

export default (async ({ client, project, directory, $ }) => {
  return {
    config: (cfg) => {
      // cfg нь тухайн үеийн нийлүүлсэн тохиргоо; талбаруудыг энд өөрчил.
    },
    "tool.execute.before": async (input, output) => {
      // хэрэгсэл ажиллахаас өмнө output.args-ийг өөрчил
    },
  }
}) satisfies Plugin
```

Холболтын цэгийн хүрээ (`output`-ийг газар дээр нь өөрчил; `void` буцаа):

- `event(input)`: event bus-ийн бүх үйл явдал
- `config(cfg)`: эхлүүлэх үед нийлүүлсэн тохиргоотой нэг удаа
- `chat.message`, `chat.params`, `chat.headers`
- `tool.execute.before`, `tool.execute.after`
- `tool.definition`
- `command.execute.before`
- `shell.env`
- `permission.ask`
- `experimental.chat.messages.transform`, `experimental.chat.system.transform`,
  `experimental.session.compacting`, `experimental.compaction.autocontinue`,
  `experimental.text.complete`

Тусгай түлхүүр-утгын бүтэцтэй хэлбэр (буцаан дуудах функц биш): `tool: { my_tool: { ... } }`,
`auth: { ... }`, `provider: { ... }`.

## MCP серверүүд

`mcp:` нь серверийн нэрээр түлхүүрлэсэн бүтэц. Сервер бүр `type`-ээр ялгагдана:

```json
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "env": { "BROWSER": "chromium" }
    },
    "github": {
      "type": "remote",
      "url": "https://...",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
    },
    "old-server": { "enabled": false }
  }
}
```

`command` нь тэмдэгт мөрүүдийн жагсаалт. `type` талбар заавал байна. Эцэг тохиргооноос өвлөсөн серверийг
идэвхгүй болгохдоо `enabled: false` ашигла. Толгойн токен зэрэг тэмдэгт мөрийн утга
`{env:VAR}` болон `{file:path}` орлуулгыг дэмжинэ; командын бүрхүүлийн маягийн `${VAR}`-г
орлуулахгүй.

## Зөвшөөрлүүд

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" }
}
```

Үйлдэл: `"allow"`, `"ask"`, `"deny"`.

Хэрэгсэл тус бүрийн утга: `"allow"` товчилсон хэлбэр (`{"*": "allow"}` гэж үзнэ), эсвэл
`{ pattern: action }` бүтэц. Бүтэц доторх оруулсан дараалал чухал. MongolGPT нь
**хамгийн сүүлд таарсан дүрмийг** үнэлдэг тул өргөн дүрмийг эхэнд, нарийн дүрмийг
сүүлд байрлуул.

`permission: "allow"` нь дээд түвшинд "бүгдийг зөвшөөр" гэсэн товчилсон хэлбэр бөгөөд
хэрэглэгчийн хүсэх хэлбэр ховор.

Мэдэгдэж буй зөвшөөрлийн түлхүүрүүд: `read, edit, glob, grep, list, bash, task,
external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop,
skill`. Эдгээрийн зарим (`todowrite, question, webfetch, websearch, doom_loop`)
нь хэв шинжээр задалсан объект биш, зөвхөн дан үйлдэл зөвшөөрнө.

`external_directory`-ийн хэв шинж нь файлын системийн зам (`~/`, бүрэн зам,
эсвэл `~/projects/**` зэрэг glob хэв шинж) байна.

Агент тус бүрийн `permission:` нь дээд түвшний `permission:`-ийг дарна. Төлөвлөгөөний горим нь
`plan` агентын зөвшөөрлийн дүрмийн багц (`edit: deny *`) дээр байрлана.

## Аврах тохиргоонууд

Хэрэглэгчийн тохиргоо эвдэрч, MongolGPT эхлэхгүй бол эдгээр орчны хувьсагч тусална:

- `MONGOLGPT_DISABLE_PROJECT_CONFIG=1`: тухайн төслийн дотоод `mongolgpt.json`-г алгасаж зөвхөн ерөнхий тохиргооноос эхэл. Төслийн хавтсаас ажиллуулахад MongolGPT ачаалагдана, хэрэглэгч эвдэрсэн файлыг засна, дараа нь туггүй дахин эхлүүлнэ.
- `MONGOLGPT_CONFIG=/path/to/file.json`: нэмэлтээр заасан тохиргоог ачаал.
- `MONGOLGPT_CONFIG_CONTENT='{"$schema":"https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/packages/web/public/config.json"}'`: мөр доторх JSON-г дотоод хамрах хүрээний нийлүүлэлтийн хамгийн сүүлийн давхарга болгон оруул.
- `MONGOLGPT_DISABLE_DEFAULT_PLUGINS=1`: анхдагч нэмэлтүүдийг алгас.
- `MONGOLGPT_PURE=1`: гаднын нэмэлтүүдийг бүхэлд нь алгас.
- `MONGOLGPT_DISABLE_EXTERNAL_SKILLS=1`, `MONGOLGPT_DISABLE_CLAUDE_CODE_SKILLS=1`: `~/.claude/` болон `~/.agents/` доорх гаднын чадварын хайлтыг алгас.

## Өөрчлөлт санал болгох үед

- Бичихийн өмнө схемтэй тулгаж баталгаажуул. Талбарын яг хэлбэрт эргэлзэж эсвэл энэ чадварт хамрагдаагүй бол таамаглахын оронд `https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/packages/web/public/config.json`-г авч схемийг унш.
- `$schema` болон хэрэглэгч өөрчлөхийг хүсээгүй байгаа талбарыг хадгал.
- Агент, команд, чадвар, нэмэлтийн тодорхойлолтод бүхнийг `mongolgpt.json` дотор мөрөөр оруулахаас илүү зөв байрлалд шинэ файл үүсгэхийг илүүд үз.
- Хэрэглэгчийн байгаа тохиргоо буруу хэлбэртэй бол ажлын харилцаагаа эвдэлгүй засахын тулд орчны хувьсагчтай аврах тохиргоонуудыг зааж өг.
- Тохиргоо өөрчилсний дараа MongolGPT-г бүрэн хааж дахин эхлүүлэхийг сануул — ажиллаж буй харилцаа аль хэдийн ачаалсан тохиргоогоо ашигласаар байна.
