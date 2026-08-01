import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@mongolgpt/core/schema"
import { Global } from "@mongolgpt/core/global"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "Ажиллуулах command" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Миллисекундээр өгөх optional timeout" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `Command ажиллуулах ажлын хавтас. Анхдагчаар одоогийн хавтсыг ашиглана. 'cd' command-ын оронд үүнийг ашигла.`,
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Shell prompt-ийн утга алга: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# PowerShell (7+) shell-ийн тэмдэглэл
- Энэ cross-platform shell нь pipeline chain operator (\`&&\` болон \`||\`)-уудыг дэмждэг.
- Interpolated string-д давхар хашилт (\`"Hello $name"\`), verbatim string-д дан хашилт ашигла.
- Alias-ийн оронд \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, \`New-Item\` зэрэг бүтэн cmdlet нэрийг илүүд үз.
- Subexpression-д \`$(...)\` ашигла. Array expression-д \`@(...)\` ашигла.
- Зам нь зай агуулсан native executable дуудахдаа call operator ашигла: \`& "path/to/exe" args\`.
- Тусгай тэмдэгтүүдийг PowerShell-ийн backtick тэмдэгтээр escape хий.`
  }
  if (name === "powershell") {
    return `# Windows PowerShell (5.1) shell-ийн тэмдэглэл
- Хамааралтай command-уудыг холбоход \`cmd1; if ($?) { cmd2 }\` ашигла.
- Interpolated string-д давхар хашилт (\`"Hello $name"\`), verbatim string-д дан хашилт ашигла.
- Alias-ийн оронд \`Get-ChildItem\`, \`Set-Content\`, \`Remove-Item\`, \`New-Item\` зэрэг бүтэн cmdlet нэрийг илүүд үз.
- Subexpression-д \`$(...)\` ашигла. Array expression-д \`@(...)\` ашигла.
- Зам нь зай агуулсан native executable дуудахдаа call operator ашигла: \`& "path/to/exe" args\`.
- Тусгай тэмдэгтүүдийг PowerShell-ийн backtick тэмдэгтээр escape хий.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell") {
    return "Command-ууд хоорондоо хамааралтай бөгөөд дарааллаар ажиллах ёстой бол Windows PowerShell (5.1) үүнийг дэмждэггүй тул энэ shell-д '&&' бүү ашигла. Дараагийн command өмнөхийн амжилтаас хамаарах үед `cmd1; if ($?) { cmd2 }` зэрэг PowerShell conditional ашигла."
  }
  if (PS.has(name)) {
    return "Command-ууд хоорондоо хамааралтай бөгөөд дарааллаар ажиллах ёстой бол тэдгээрийг нэг bash tool call дотор '&&'-ээр холбо (жишээлбэл, `git add . && git commit -m \"message\" && git push`). Нэг үйлдэл нөгөөхөөсөө өмнө дуусах ёстой бол (жишээлбэл, Copy-Item-ийн өмнө New-Item, git үйлдэлд bash-ийн өмнө Write, эсвэл git commit-ийн өмнө git add) эдгээр үйлдлийг дарааллаар ажиллуул."
  }
  if (CMD.has(name)) {
    return "Command-ууд хоорондоо хамааралтай бөгөөд дарааллаар ажиллах ёстой бол тэдгээрийг нэг bash tool call дотор `&&`-ээр холбо (жишээлбэл, `mkdir out && dir out`). Нэг үйлдэл нөгөөхөөсөө өмнө дуусах ёстой бол эдгээр үйлдлийг дарааллаар ажиллуул."
  }
  return "Command-ууд хоорондоо хамааралтай бөгөөд дарааллаар ажиллах ёстой бол тэдгээрийг нэг Bash call дотор '&&'-ээр холбо (жишээлбэл, `git add . && git commit -m \"message\" && git push`). Нэг үйлдэл нөгөөхөөсөө өмнө дуусах ёстой бол (жишээлбэл, cp-ийн өмнө mkdir, git үйлдэлд Bash-ийн өмнө Write, эсвэл git commit-ийн өмнө git add) эдгээр үйлдлийг дарааллаар ажиллуул."
}

function bashCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `Command ажиллуулахын өмнө дараах алхмуудыг дага:

1. Хавтас шалгах:
   - Command шинэ хавтас эсвэл файл үүсгэх бол эхлээд \`ls\` ашиглан parent directory байгаа бөгөөд зөв байрлал мөн эсэхийг шалга
   - Жишээлбэл, "mkdir foo/bar" ажиллуулахын өмнө эхлээд \`ls foo\` ашиглан "foo" байгаа бөгөөд зорьсон parent directory мөн эсэхийг шалга

2. Command ажиллуулах:
   - Зай агуулсан file path-уудыг үргэлж давхар хашилтаар хүрээл (жишээлбэл, rm "path with spaces/file.txt")
   - Зөв хашилтын жишээ:
     - mkdir "/Users/name/My Documents" (зөв)
     - mkdir /Users/name/My Documents (буруу - амжилтгүй болно)
     - python "/path/with spaces/script.py" (зөв)
     - python /path/with spaces/script.py (буруу - амжилтгүй болно)
   - Зөв хашилт хэрэглэснээ баталгаажуулсны дараа command-ыг ажиллуул.
   - Command-ын гаралтыг хадгал.

Хэрэглэх тэмдэглэл:
  - command argument заавал шаардлагатай.
  - Миллисекундээр optional timeout зааж болно. Заагаагүй бол command ${defaultTimeoutMs}ms-ийн дараа timeout болно.
  - Гаралт ${limits.maxLines} мөр эсвэл ${limits.maxBytes} byte-ээс хэтэрвэл таслагдаж, бүтэн гаралт файлд бичигдэнэ. Тодорхой хэсгийг уншихдаа Read-ийг offset/limit-тэй ашиглах эсвэл бүтэн агуулгаас хайхдаа Grep ашиглаж болно. Гаралтыг хязгаарлахын тулд \`head\`, \`tail\` болон бусад truncation command БҮҮ ашигла; илүү нарийн хайхад зориулж бүтэн гаралт файлд аль хэдийн хадгалагдсан байна.

  - Илэрхий заагаагүй эсвэл тухайн даалгаварт үнэхээр шаардлагагүй бол Bash-д \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, \`echo\` command ашиглахаас зайлсхий. Оронд нь эдгээр command-д зориулсан тусгай tool-уудыг үргэлж илүүд үз:
    - Файл хайх: Glob ашигла (find эсвэл ls БИШ)
    - Агуулга хайх: Grep ашигла (grep эсвэл rg БИШ)
    - Файл унших: Read ашигла (cat/head/tail БИШ)
    - Файл засах: Edit ашигла (sed/awk БИШ)
    - Файл бичих: Write ашигла (echo >/cat <<EOF БИШ)
    - Харилцах: Текстийг шууд гарга (echo/printf БИШ)
  - Олон command өгөх үед:
    - Command-ууд бие даасан бөгөөд зэрэг ажиллаж болох бол нэг message дотор олон bash tool call өг. Жишээлбэл, "git status" болон "git diff" ажиллуулах шаардлагатай бол нэг message дотор хоёр bash tool call-ыг зэрэг өг.
    - ${chain}
    - Command-уудыг дарааллаар ажиллуулах шаардлагатай боловч өмнөх command амжилтгүй болсон эсэх хамаарахгүй үед л ';' ашигла
    - Command-уудыг тусгаарлахын тулд newline БҮҮ ашигла (хашилттай string дотор newline байж болно)
  - \`cd <directory> && <command>\` хэлбэрийг ашиглахаас ЗАЙЛСХИЙ. Хавтас солихын оронд \`workdir\` parameter ашигла.
    <good-example>
    workdir="/foo/bar"-тай command: pytest tests ашигла
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>`
}

function powershellCommandSection(
  name: string,
  chain: string,
  pathSep: string,
  limits: Limits,
  defaultTimeoutMs: number,
) {
  return `${powershellNotes(name)}

Command ажиллуулахын өмнө дараах алхмуудыг дага:

1. Хавтас шалгах:
   - Command шинэ хавтас эсвэл файл үүсгэх бол эхлээд \`Test-Path -LiteralPath <parent>\` ашиглан parent directory байгаа бөгөөд зөв байрлал мөн эсэхийг шалга
   - Жишээлбэл, \`foo${pathSep}bar\` үүсгэхийн өмнө эхлээд \`Test-Path -LiteralPath "foo"\` ашиглан \`foo\` байгаа бөгөөд зорьсон parent directory мөн эсэхийг шалга

2. Command ажиллуулах:
   - Зай агуулсан file path-уудыг үргэлж давхар хашилтаар хүрээл (жишээлбэл, Remove-Item -LiteralPath "path with spaces${pathSep}file.txt")
   - Зөв хашилтын жишээ:
     - New-Item -ItemType Directory -Path "My Documents" (зөв)
     - New-Item -ItemType Directory -Path My Documents (буруу - path сална)
     - & "path with spaces${pathSep}script.ps1" (зөв)
     - path with spaces${pathSep}script.ps1 (буруу - path салж, дуудагдахгүй)
   - Зөв хашилт хэрэглэснээ баталгаажуулсны дараа command-ыг ажиллуул.
   - Command-ын гаралтыг хадгал.

Хэрэглэх тэмдэглэл:
  - command argument заавал шаардлагатай.
  - Миллисекундээр optional timeout зааж болно. Заагаагүй бол command ${defaultTimeoutMs}ms-ийн дараа timeout болно.
  - Гаралт ${limits.maxLines} мөр эсвэл ${limits.maxBytes} byte-ээс хэтэрвэл таслагдаж, бүтэн гаралт файлд бичигдэнэ. Тодорхой хэсгийг уншихдаа Read-ийг offset/limit-тэй ашиглах эсвэл бүтэн агуулгаас хайхдаа Grep ашиглаж болно. Гаралтыг хязгаарлахын тулд \`Select-Object -First\`, \`Select-Object -Last\` болон бусад truncation command БҮҮ ашигла; илүү нарийн хайхад зориулж бүтэн гаралт файлд аль хэдийн хадгалагдсан байна.

  - Илэрхий заагаагүй эсвэл тухайн даалгаварт үнэхээр шаардлагагүй бол Shell-д PowerShell-ийн file/content cmdlet ашиглахаас зайлсхий. Оронд нь эдгээр command-д зориулсан тусгай tool-уудыг үргэлж илүүд үз:
    - Файл хайх: Glob ашигла (Get-ChildItem БИШ)
    - Агуулга хайх: Grep ашигла (Select-String БИШ)
    - Файл унших: Read ашигла (Get-Content БИШ)
    - Файл засах: Edit ашигла (Set-Content БИШ)
    - Файл бичих: Write ашигла (Set-Content/Out-File эсвэл here-string БИШ)
    - Харилцах: Текстийг шууд гарга (Write-Output/Write-Host БИШ)
  - Олон command өгөх үед:
    - Command-ууд бие даасан бөгөөд зэрэг ажиллаж болох бол нэг message дотор олон bash tool call өг. Жишээлбэл, "git status" болон "git diff" ажиллуулах шаардлагатай бол нэг message дотор хоёр bash tool call-ыг зэрэг өг.
    - ${chain}
    - Command-уудыг дарааллаар ажиллуулах шаардлагатай боловч өмнөх command амжилтгүй болсон эсэх хамаарахгүй үед л \`;\` ашигла
    - Command-уудыг тусгаарлахын тулд newline БҮҮ ашигла (хашилттай string дотор newline байж болно)
  - Command дотор хавтас солихоос ЗАЙЛСХИЙ. Хавтас солихын оронд \`workdir\` parameter ашигла.
    <good-example>
    workdir="project${pathSep}subdir"-тай command: pytest tests ашигла
    </good-example>
    <bad-example>
    ${name === "powershell" ? `Set-Location -LiteralPath "project${pathSep}subdir"; if ($?) { pytest tests }` : `Set-Location -LiteralPath "project${pathSep}subdir" && pytest tests`}
    </bad-example>`
}

function cmdCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `# cmd.exe shell-ийн тэмдэглэл
- Зай агуулсан path-д давхар хашилт ашигла.
- Environment variable-д %VAR% ашигла.
- Байгаа эсэхийг шалгахад \`if exist\` ашигла.
- Нэг batch-style command-аас өөр batch file дуудахдаа \`call\` ашигла.

Command ажиллуулахын өмнө дараах алхмуудыг дага:

1. Хавтас шалгах:
   - Command шинэ хавтас эсвэл файл үүсгэх бол эхлээд \`if exist\` ашиглан parent directory байгаа бөгөөд зөв байрлал мөн эсэхийг шалга
   - Жишээлбэл, \`foo\\bar\` үүсгэхийн өмнө эхлээд \`if exist "foo\\" dir "foo"\` ашиглан \`foo\` байгаа бөгөөд зорьсон parent directory мөн эсэхийг шалга

2. Command ажиллуулах:
   - Зай агуулсан file path-уудыг үргэлж давхар хашилтаар хүрээл (жишээлбэл, del "path with spaces\\file.txt")
   - Зөв хашилтын жишээ:
     - mkdir "My Documents" (зөв)
     - mkdir My Documents (буруу - path сална)
     - call "path with spaces\\script.bat" (зөв)
     - path with spaces\\script.bat (буруу - path салж, зөв дуудагдахгүй)
   - Зөв хашилт хэрэглэснээ баталгаажуулсны дараа command-ыг ажиллуул.
   - Command-ын гаралтыг хадгал.

Хэрэглэх тэмдэглэл:
  - command argument заавал шаардлагатай.
  - Миллисекундээр optional timeout зааж болно. Заагаагүй бол command ${defaultTimeoutMs}ms-ийн дараа timeout болно.
  - Гаралт ${limits.maxLines} мөр эсвэл ${limits.maxBytes} byte-ээс хэтэрвэл таслагдаж, бүтэн гаралт файлд бичигдэнэ. Тодорхой хэсгийг уншихдаа Read-ийг offset/limit-тэй ашиглах эсвэл бүтэн агуулгаас хайхдаа Grep ашиглаж болно. Гаралтыг хязгаарлахын тулд \`more\` болон бусад pagination command БҮҮ ашигла; илүү нарийн хайхад зориулж бүтэн гаралт файлд аль хэдийн хадгалагдсан байна.

  - Илэрхий заагаагүй эсвэл тухайн даалгаварт үнэхээр шаардлагагүй бол Shell-д cmd.exe-ийн file/content command ашиглахаас зайлсхий. Оронд нь эдгээр command-д зориулсан тусгай tool-уудыг үргэлж илүүд үз:
    - Файл хайх: Glob ашигла (dir /s БИШ)
    - Агуулга хайх: Grep ашигла (findstr БИШ)
    - Файл унших: Read ашигла (type БИШ)
    - Файл засах: Edit ашигла (copy БИШ)
    - Файл бичих: Write ашигла (echo > file БИШ)
    - Харилцах: Текстийг шууд гарга (echo БИШ)
  - Олон command өгөх үед:
    - Command-ууд бие даасан бөгөөд зэрэг ажиллаж болох бол нэг message дотор олон bash tool call өг. Жишээлбэл, "dir" болон "where cmd" ажиллуулах шаардлагатай бол нэг message дотор хоёр bash tool call-ыг зэрэг өг.
    - ${chain}
    - Command-уудыг дарааллаар ажиллуулах шаардлагатай боловч өмнөх command амжилтгүй болсон эсэх хамаарахгүй үед л \`&\` ашигла
    - Command-уудыг тусгаарлахын тулд newline БҮҮ ашигла (хашилттай string дотор newline байж болно)
  - Command дотор хавтас солихоос ЗАЙЛСХИЙ. Хавтас солихын оронд \`workdir\` parameter ашигла.
    <good-example>
    workdir="project\\subdir"-тай command: dir ашигла
    </good-example>
    <bad-example>
    cd /d "project\\subdir" && dir
    </bad-example>`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  if (CMD.has(name)) {
    return {
      intro: `Өгсөн ${shellDisplayName(name)} command-ыг optional timeout-той ажиллуулж, зөв боловсруулалт болон аюулгүй байдлын арга хэмжээг хангана.`,
      workdirSection:
        "Бүх command анхдагчаар одоогийн working directory-д ажиллана. Өөр directory-д command ажиллуулах шаардлагатай бол `workdir` parameter ашигла. Command дотор directory солихоос ЗАЙЛСХИЙ, оронд нь `workdir` ашигла.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
      gitCommands: "git command-ууд",
      gitCommandRestriction: "git command-ууд",
      createPrInstruction: "cmd.exe-ийн хашилтыг энгийн байлгахын тулд түр body file ашиглан PR үүсгэ.",
      createPrExample: `(\n  echo ## Summary\n  echo - ^<1-3 bullet points^>\n) > pr-body.txt\ngh pr create --title "the pr title" --body-file pr-body.txt`,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Өгсөн ${shellDisplayName(name)} command-ыг optional timeout-той ажиллуулж, зөв боловсруулалт болон аюулгүй байдлын арга хэмжээг хангана.`,
      workdirSection:
        "Бүх command анхдагчаар одоогийн working directory-д ажиллана. Өөр directory-д command ажиллуулах шаардлагатай бол `workdir` parameter ашигла. Command дотор directory солихоос ЗАЙЛСХИЙ, оронд нь `workdir` ашигла.",
      commandSection: powershellCommandSection(
        name,
        chain,
        platform === "win32" ? "\\" : "/",
        limits,
        defaultTimeoutMs,
      ),
      gitCommands: "git command-ууд",
      gitCommandRestriction: "git command-ууд",
      createPrInstruction: "Body-г зөв дамжуулахын тулд PowerShell here-string-тэй gh pr create ашиглан PR үүсгэ.",
      createPrExample: `gh pr create --title "the pr title" --body @'
## Summary
- <1-3 bullet points>
'@`,
    }
  }
  return {
    intro:
      "Өгсөн bash command-ыг persistent shell session дотор optional timeout-той ажиллуулж, зөв боловсруулалт болон аюулгүй байдлын арга хэмжээг хангана.",
    workdirSection:
      "Бүх command анхдагчаар одоогийн working directory-д ажиллана. Өөр directory-д command ажиллуулах шаардлагатай бол `workdir` parameter ашигла. `cd <directory> && <command>` хэлбэрээс ЗАЙЛСХИЙ, оронд нь `workdir` ашигла.",
    commandSection: bashCommandSection(chain, limits, defaultTimeoutMs),
    gitCommands: "bash command-ууд",
    gitCommandRestriction: "git bash command-ууд",
    createPrInstruction:
      "Доорх format-аар gh pr create ашиглан PR үүсгэ. Зөв format-ыг хадгалахын тулд body-г HEREDOC-оор дамжуул.",
    createPrExample: `gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>`,
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const selected = profile(name, platform, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: Global.Path.tmp,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      gitCommands: selected.gitCommands,
      toolName: ShellID.ToolID,
      gitCommandRestriction: selected.gitCommandRestriction,
      createPrInstruction: selected.createPrInstruction,
      createPrExample: selected.createPrExample,
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
