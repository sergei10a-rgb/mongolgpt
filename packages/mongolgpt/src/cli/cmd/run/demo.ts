// Demo mode for testing direct interactive mode without a real SDK.
//
// Enabled with `--demo`. Intercepts prompt submissions and generates synthetic
// SDK events that feed through the real reducer and footer pipeline. This
// lets you test scrollback formatting, permission UI, question UI, and tool
// snapshots without making actual model calls. Pass a demo slash command as
// the initial interactive message to trigger a preview immediately.
//
// Slash commands:
//   /permission [kind] → triggers a permission request variant
//   /question [kind]   → triggers a question request variant
//   /fmt <kind>   → emits a specific tool/text type (text, reasoning, bash,
//                   write, edit, patch, task, todo, question, error, mix)
//
// Demo mode also handles permission and question replies locally, completing
// or failing the synthetic tool parts as appropriate.
import path from "path"
import type { Event, ToolPart } from "@mongolgpt/sdk/v2"
import { createSessionData, reduceSessionData, type SessionData } from "./session-data"
import { writeSessionOutput } from "./stream"
import type { FooterApi, PermissionReply, QuestionReject, QuestionReply, RunPrompt, StreamCommit } from "./types"

const KINDS = [
  "markdown",
  "table",
  "text",
  "reasoning",
  "bash",
  "write",
  "edit",
  "patch",
  "task",
  "todo",
  "question",
  "error",
  "mix",
]
const PERMISSIONS = ["edit", "bash", "read", "task", "external", "doom"] as const
const QUESTIONS = ["multi", "single", "checklist", "custom"] as const

type PermissionKind = (typeof PERMISSIONS)[number]
type QuestionKind = (typeof QUESTIONS)[number]

function permissionKind(value: string | undefined): PermissionKind | undefined {
  const next = (value || "edit").toLowerCase()
  return PERMISSIONS.find((item) => item === next)
}

function questionKind(value: string | undefined): QuestionKind | undefined {
  const next = (value || "multi").toLowerCase()
  return QUESTIONS.find((item) => item === next)
}

const SAMPLE_MARKDOWN = [
  "# Шууд горимын үзүүлэн",
  "",
  "Энэ бол шууд горимын форматлалыг шалгах бодитой туслахын хариулт юм.",
  "Нэг урсгал хариултад **тод**, _налуу_, `мөр доторх код`, холбоос, кодын блок болон хүснэгтийг хослуулсан.",
  "",
  "## Хураангуй",
  "",
  "- Сүүлийн Markdown блок хүлээлгийн үед бүрэн харагдахаар төгсгөлийн шинэчлэлтийг сэргээв.",
  "- Markdown-ийн гүйлгэх түүхийг дээд түвшний блокийн заагаар шинэчилдэг болгов.",
  "- Хуваагдсан доод хэсгийн дүрслэлд регрессийн шалгалт нэмэв.",
  "",
  "## Төлөв",
  "",
  "| Хэсэг | Өмнө | Дараа | Тайлбар |",
  "| --- | --- | --- | --- |",
  "| Шууд горим | Төгсгөлийн мөрүүд дутуу | Тогтвортой | Сүүлийн Markdown блок хүлээлгийн үед бүрэн гарна |",
  "| Хүснэгт | Урсгал горимд алга болдог | Харагдана | Блокт суурилсан шинэчлэлт OpenTUI үзүүлэнтэй таарна |",
  "| Тест | Хэсэгчилсэн | Өргөн хүрээтэй | Доод хэсгийн хуваагдсан дүрслэлийн зураглал багтсан |",
  "",
  "> Мөр шилжилт болон шинэчлэлтийн алдааг хурдан илрүүлэхийн тулд энэ жишээнд зориуд өргөн хүснэгт оруулсан.",
  "",
  "```ts",
  "const result = { markdown: true, tables: 2, stable: true }",
  "```",
  "",
  "## Файлууд",
  "",
  "| Файл | Өөрчлөлт |",
  "| --- | --- |",
  "| `scrollback.surface.ts` | Markdown шинэчлэлтийн логикийг хуваагдсан доод хэсгийн үзүүлэнтэй тааруулав |",
  "| `footer.ts` | Зөвхөн доод хэсгийн өндөр өөрчлөгдөхөд идэвхтэй харагдацыг хадгална |",
  "| `footer.test.ts` | Хүлээлгийн төгсгөлд хуваагдсан доод хэсгийн бодит Markdown агуулгыг шалгана |",
  "",
  "Дараагийн алхам: зөвхөн хүснэгтийн товч жишээ харах бол `/fmt table` ажиллуулна уу.",
].join("\n")

const SAMPLE_TABLE = [
  "# Хүснэгтийн жишээ",
  "",
  "| Төрөл | Жишээ | Тайлбар |",
  "| --- | --- | --- |",
  "| Босоо зураас | `A\\|B` | Тусгаарласан босоо зураас нэг нүдэнд үлдэнэ |",
  "| Юникод | `漢字` | Өргөн тэмдэгтүүдийн зэрэгцүүлэлт алдагдахгүй |",
  "| Мөр шилжилт | `LongTokenWithoutNaturalBreaks_1234567890` | Өргөний ачааллыг шалгахад тустай |",
  "| Төлөв | дууссан | Хүлээлгийн дараа ч төгсгөлийн мөр харагдана |",
].join("\n")

type Ref = {
  msg: string
  part: string
  call: string
  tool: string
  input: Record<string, unknown>
  start: number
}

type Ask = {
  ref: Ref
}

type Perm = {
  ref: Ref
  done: {
    title: string
    output: string
    metadata?: Record<string, unknown>
  }
}

type Permit = {
  ref: Ref
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  always: string[]
  done: Perm["done"]
}

type State = {
  id: string
  thinking: boolean
  data: SessionData
  footer: FooterApi
  limits: () => Record<string, number>
  msg: number
  part: number
  call: number
  perm: number
  ask: number
  perms: Map<string, Perm>
  asks: Map<string, Ask>
}

type Input = {
  sessionID: string
  thinking: boolean
  limits: () => Record<string, number>
  footer: FooterApi
}

function note(footer: FooterApi, text: string): void {
  footer.append({
    kind: "system",
    text,
    phase: "start",
    source: "system",
  })
}

function clearSubagent(footer: FooterApi): void {
  footer.event({
    type: "stream.subagent",
    state: {
      tabs: [],
      details: {},
      permissions: [],
      questions: [],
    },
  })
}

function showSubagent(
  state: State,
  input: {
    sessionID: string
    partID: string
    callID: string
    label: string
    description: string
    status: "running" | "completed" | "cancelled" | "error"
    title?: string
    toolCalls?: number
    commits: StreamCommit[]
  },
) {
  state.footer.event({
    type: "stream.subagent",
    state: {
      tabs: [
        {
          sessionID: input.sessionID,
          partID: input.partID,
          callID: input.callID,
          label: input.label,
          description: input.description,
          status: input.status,
          title: input.title,
          toolCalls: input.toolCalls,
          lastUpdatedAt: Date.now(),
        },
      ],
      details: {
        [input.sessionID]: {
          sessionID: input.sessionID,
          commits: input.commits,
        },
      },
      permissions: [],
      questions: [],
    },
  })
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }

    if (signal.aborted) {
      resolve()
      return
    }

    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done)
      resolve()
    }, ms)

    signal.addEventListener("abort", done, { once: true })
  })
}

function split(text: string): string[] {
  if (text.length <= 48) {
    return [text]
  }

  const size = Math.ceil(text.length / 3)
  return [text.slice(0, size), text.slice(size, size * 2), text.slice(size * 2)]
}

function take(state: State, key: "msg" | "part" | "call" | "perm" | "ask", prefix: string): string {
  state[key] += 1
  return `demo_${prefix}_${state[key]}`
}

function feed(state: State, event: Event): void {
  const out = reduceSessionData({
    data: state.data,
    event,
    sessionID: state.id,
    thinking: state.thinking,
    limits: state.limits(),
  })
  state.data = out.data
  writeSessionOutput(
    {
      footer: state.footer,
    },
    out,
  )
}

function open(state: State): string {
  const id = take(state, "msg", "msg")
  feed(state, {
    type: "message.updated",
    properties: {
      sessionID: state.id,
      info: {
        id,
        sessionID: state.id,
        role: "assistant",
        time: {
          created: Date.now(),
        },
        parentID: `user_${id}`,
        modelID: "demo",
        providerID: "demo",
        mode: "demo",
        agent: "demo",
        path: {
          cwd: process.cwd(),
          root: process.cwd(),
        },
        cost: 0.001,
        tokens: {
          input: 120,
          output: 320,
          reasoning: 80,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
    },
  } as Event)
  return id
}

async function emitText(state: State, body: string, signal?: AbortSignal): Promise<void> {
  const msg = open(state)
  const part = take(state, "part", "part")
  const start = Date.now()

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "text",
        text: "",
        time: {
          start,
        },
      },
    },
  } as Event)

  let next = ""
  for (const item of split(body)) {
    if (signal?.aborted) {
      return
    }

    next += item
    feed(state, {
      type: "message.part.delta",
      properties: {
        sessionID: state.id,
        messageID: msg,
        partID: part,
        field: "text",
        delta: item,
      },
    } as Event)
    await wait(45, signal)
  }

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "text",
        text: next,
        time: {
          start,
          end: Date.now(),
        },
      },
    },
  } as Event)
}

async function emitReasoning(state: State, body: string, signal?: AbortSignal): Promise<void> {
  const msg = open(state)
  const part = take(state, "part", "part")
  const start = Date.now()

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "reasoning",
        text: "",
        time: {
          start,
        },
      },
    },
  } as Event)

  let next = ""
  for (const item of split(body)) {
    if (signal?.aborted) {
      return
    }

    next += item
    feed(state, {
      type: "message.part.delta",
      properties: {
        sessionID: state.id,
        messageID: msg,
        partID: part,
        field: "text",
        delta: item,
      },
    } as Event)
    await wait(45, signal)
  }

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "reasoning",
        text: next,
        time: {
          start,
          end: Date.now(),
        },
      },
    },
  } as Event)
}

function make(state: State, tool: string, input: Record<string, unknown>): Ref {
  return {
    msg: open(state),
    part: take(state, "part", "part"),
    call: take(state, "call", "call"),
    tool,
    input,
    start: Date.now(),
  }
}

function startTool(state: State, ref: Ref, metadata: Record<string, unknown> = {}): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "running",
          input: ref.input,
          metadata,
          time: {
            start: ref.start,
          },
        },
      },
    },
  } as Event)
}

function askPermission(state: State, item: Permit): void {
  startTool(state, item.ref)

  const id = take(state, "perm", "perm")
  state.perms.set(id, {
    ref: item.ref,
    done: item.done,
  })

  feed(state, {
    type: "permission.asked",
    properties: {
      id,
      sessionID: state.id,
      permission: item.permission,
      patterns: item.patterns,
      metadata: item.metadata ?? {},
      always: item.always,
      tool: {
        messageID: item.ref.msg,
        callID: item.ref.call,
      },
    },
  } as Event)
}

function doneTool(
  state: State,
  ref: Ref,
  output: {
    title: string
    output: string
    metadata?: Record<string, unknown>
  },
): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "completed",
          input: ref.input,
          output: output.output,
          title: output.title,
          metadata: output.metadata ?? {},
          time: {
            start: ref.start,
            end: Date.now(),
          },
        },
      },
    },
  } as Event)
}

function failTool(state: State, ref: Ref, error: string): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "error",
          input: ref.input,
          error,
          metadata: {},
          time: {
            start: ref.start,
            end: Date.now(),
          },
        },
      },
    },
  } as Event)
}

function emitError(state: State, text: string): void {
  const event = {
    id: `session.error:${state.id}:${Date.now()}`,
    type: "session.error",
    properties: {
      sessionID: state.id,
      error: {
        name: "UnknownError",
        data: {
          message: text,
        },
      },
    },
  } satisfies Event
  feed(state, event)
}

async function emitBash(state: State, signal?: AbortSignal): Promise<void> {
  const ref = make(state, "bash", {
    command: "git status",
    workdir: process.cwd(),
    description: "git status харуулах",
  })
  startTool(state, ref)
  await wait(70, signal)
  doneTool(state, ref, {
    title: "git status",
    output: `${process.cwd()}\ngit status\nҮзүүлэн салбар дээр байна\ncommit хийх зүйлгүй, ажлын мод цэвэр байна\n`,
    metadata: {
      exitCode: 0,
    },
  })
}

function emitWrite(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "write", {
    filePath: file,
    content: "export const demo = 42\n",
  })
  doneTool(state, ref, {
    title: "бичих",
    output: "",
    metadata: {},
  })
}

function emitEdit(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "edit", {
    filePath: file,
  })
  doneTool(state, ref, {
    title: "засварлах",
    output: "",
    metadata: {
      diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
    },
  })
}

function emitPatch(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "apply_patch", {
    patchText: "*** Begin Patch\n*** End Patch",
  })
  doneTool(state, ref, {
    title: "нөхөөс хэрэглэх",
    output: "",
    metadata: {
      files: [
        {
          type: "update",
          filePath: file,
          relativePath: "src/demo-format.ts",
          diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
          deletions: 1,
        },
        {
          type: "add",
          filePath: path.join(process.cwd(), "README-demo.md"),
          relativePath: "README-demo.md",
          diff: "@@ -0,0 +1,4 @@\n+# Үзүүлэн\n+Энэ бол үүсгэсэн урьдчилан харах файл.\n",
          deletions: 0,
        },
      ],
    },
  })
}

function emitTask(state: State): void {
  const ref = make(state, "task", {
    description: "reducer-ийн холболтын цэгүүдийг run/* дотроос хайх",
    subagent_type: "explore",
  })
  doneTool(state, ref, {
    title: "Reducer-ийн холболтын цэгүүд олдлоо",
    output: "",
    metadata: {
      toolcalls: 4,
      sessionId: "sub_demo_1",
    },
  })
  const part = {
    id: "sub_demo_tool_1",
    type: "tool",
    sessionID: "sub_demo_1",
    messageID: "sub_demo_msg_tool",
    callID: "sub_demo_call_1",
    tool: "read",
    state: {
      status: "running",
      input: {
        filePath: "packages/mongolgpt/src/cli/cmd/run/stream.ts",
        offset: 1,
        limit: 200,
      },
      time: {
        start: Date.now(),
      },
    },
  } satisfies ToolPart
  showSubagent(state, {
    sessionID: "sub_demo_1",
    partID: ref.part,
    callID: ref.call,
    label: "Судлах",
    description: "reducer-ийн холболтын цэгүүдийг run/* дотроос хайх",
    status: "completed",
    title: "Reducer-ийн холболтын цэгүүд олдлоо",
    toolCalls: 4,
    commits: [
      {
        kind: "user",
        text: "Reducer-ийн холболтын цэгүүдийг run/* дотроос хай",
        phase: "start",
        source: "system",
      },
      {
        kind: "reasoning",
        text: "Reducer болон доод хэсгийн заагийг мөрдөж байна",
        phase: "progress",
        source: "reasoning",
        messageID: "sub_demo_msg_reasoning",
        partID: "sub_demo_reasoning_1",
      },
      {
        kind: "tool",
        text: "унших хэрэгсэл ажиллаж байна",
        phase: "start",
        source: "tool",
        messageID: "sub_demo_msg_tool",
        partID: "sub_demo_tool_1",
        tool: "read",
        part,
      },
      {
        kind: "assistant",
        text: "Доод хэсгийн шинэчлэл stream.ts-ээр дамжин RunFooter-т хүрнэ",
        phase: "progress",
        source: "assistant",
        messageID: "sub_demo_msg_text",
        partID: "sub_demo_text_1",
      },
    ],
  })
}

function emitTodo(state: State): void {
  const ref = make(state, "todowrite", {
    todos: [
      {
        content: "Зөвшөөрлийн интерфэйсийг ажиллуулах",
        status: "completed",
      },
      {
        content: "Асуултын интерфэйсийг ажиллуулах",
        status: "in_progress",
      },
      {
        content: "Хэрэгслийн форматлалыг тааруулах",
        status: "pending",
      },
    ],
  })
  doneTool(state, ref, {
    title: "todowrite",
    output: "",
    metadata: {},
  })
}

function emitQuestionTool(state: State): void {
  const ref = make(state, "question", {
    questions: [
      {
        header: "Загвар",
        question: "Ямар гаралтын загварыг шалгах вэ?",
        options: [
          { label: "Ялгаа", description: "Өөрчлөлтийн ялгааны блок харуулах" },
          { label: "Код", description: "Кодын блок харуулах" },
        ],
        multiple: false,
      },
      {
        header: "Нэмэлт",
        question: "Нэмэлт мөрүүд сонгоно уу",
        options: [
          { label: "Хэрэглээ", description: "Хэрэглээний мөр нэмэх" },
          { label: "Хугацаа", description: "Хугацааны мөр нэмэх" },
        ],
        multiple: true,
        custom: true,
      },
    ],
  })
  doneTool(state, ref, {
    title: "асуулт",
    output: "",
    metadata: {
      answers: [["Ялгаа"], ["Хэрэглээ", "тусгай тэмдэглэл"]],
    },
  })
}

function emitPermission(state: State, kind: PermissionKind = "edit"): void {
  const root = process.cwd()
  const file = path.join(root, "src", "demo-format.ts")

  if (kind === "bash") {
    const command = "git status --short"
    const ref = make(state, "bash", {
      command,
      workdir: root,
      description: "ажлын модны өөрчлөлтүүдийг шалгах",
    })
    askPermission(state, {
      ref,
      permission: "bash",
      patterns: [command],
      always: ["*"],
      done: {
        title: "git status --short",
        output: `${root}\ngit status --short\n M src/demo-format.ts\n?? src/demo-permission.ts\n`,
        metadata: {
          exitCode: 0,
        },
      },
    })
    return
  }

  if (kind === "read") {
    const target = path.join(root, "package.json")
    const ref = make(state, "read", {
      filePath: target,
      offset: 1,
      limit: 80,
    })
    askPermission(state, {
      ref,
      permission: "read",
      patterns: [target],
      always: [target],
      done: {
        title: "унших",
        output: ["1: {", '2:   "name": "mongolgpt",', '3:   "private": true', "4: }"].join("\n"),
        metadata: {},
      },
    })
    return
  }

  if (kind === "task") {
    const ref = make(state, "task", {
      description: "шууд горимын хүсэлтийн доод хэсгийн зайг шалгах",
      subagent_type: "explore",
    })
    askPermission(state, {
      ref,
      permission: "task",
      patterns: ["explore"],
      always: ["*"],
      done: {
        title: "Доод хэсгийн зай шалгагдлаа",
        output: "",
        metadata: {
          toolcalls: 3,
          sessionId: "sub_demo_perm_1",
        },
      },
    })
    return
  }

  if (kind === "external") {
    const dir = path.join(path.dirname(root), "demo-shared")
    const target = path.join(dir, "README.md")
    const ref = make(state, "read", {
      filePath: target,
      offset: 1,
      limit: 40,
    })
    askPermission(state, {
      ref,
      permission: "external_directory",
      patterns: [`${dir}/**`],
      metadata: {
        parentDir: dir,
        filepath: target,
      },
      always: [`${dir}/**`],
      done: {
        title: "унших",
        output: `1: # Гадаад үзүүлэн\n2: Хуваалцсан урьдчилан харах файл\nЗам: ${target}`,
        metadata: {},
      },
    })
    return
  }

  if (kind === "doom") {
    const ref = make(state, "task", {
      description: "давтагдсан алдааны дараа форматлагчийг дахин оролдох",
      subagent_type: "general",
    })
    askPermission(state, {
      ref,
      permission: "doom_loop",
      patterns: ["*"],
      always: ["*"],
      done: {
        title: "Дахин оролдохыг зөвшөөрлөө",
        output: "Давтагдсан алдааны дараа үргэлжилж байна.\n",
        metadata: {},
      },
    })
    return
  }

  const diff = "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n"
  const ref = make(state, "edit", {
    filePath: file,
    filepath: file,
    diff,
  })
  askPermission(state, {
    ref,
    permission: "edit",
    patterns: [file],
    always: [file],
    done: {
      title: "засварлах",
      output: "",
      metadata: {
        diff,
      },
    },
  })
}

function emitQuestion(state: State, kind: QuestionKind = "multi"): void {
  const questions = (() => {
    if (kind === "single") {
      return [
        {
          header: "Горим",
          question: "Зай, байрлалын шалгалтад аль доод хэсгийг жишиг болгох вэ?",
          options: [
            { label: "Зөвшөөрөл", description: "Зөвшөөрлийн доод хэсгийг шалгах" },
            { label: "Асуулт", description: "Асуултын доод хэсгийг нээлттэй байлгах" },
            { label: "Хүсэлт", description: "Энгийн хүсэлт бичих хэсэг рүү буцах" },
          ],
          multiple: false,
          custom: false,
        },
      ]
    }

    if (kind === "checklist") {
      return [
        {
          header: "Шалгалт",
          question: "Дараа шалгах шууд горимын тохиолдлуудаа сонгоно уу",
          options: [
            { label: "Ялгаа", description: "Доод хэсэгт засварын ялгаа харуулах" },
            { label: "Даалгавар", description: "Бүтэцтэй даалгаврын хураангуй харуулах" },
            { label: "Хийх зүйл", description: "Хийх зүйлийн агшин зураг харуулах" },
            { label: "Алдаа", description: "Ярианы тэмдэглэлийн алдааны мөр харуулах" },
          ],
          multiple: true,
          custom: false,
        },
      ]
    }

    if (kind === "custom") {
      return [
        {
          header: "Хариу",
          question: "Доод хэсгийн урьдчилан харах дээр ямар тусгай хариу харагдах вэ?",
          options: [
            { label: "Богино тэмдэглэл", description: "Хариуг нэг мөрт багтаах" },
            { label: "Ороосон тэмдэглэл", description: "Мөр шилжилтийг шалгахын тулд урт хариу ашиглах" },
          ],
          multiple: false,
          custom: true,
        },
      ]
    }

    return [
      {
        header: "Байрлал",
        question: "Шалгах үед доод хэсгийн аль харагдац идэвхтэй үлдэх вэ?",
        options: [
          { label: "Хүсэлт", description: "Хүсэлт бичих хэсэг рүү буцах" },
          { label: "Асуулт", description: "Асуултыг нээлттэй байлгах" },
        ],
        multiple: false,
      },
      {
        header: "Мөрүүд",
        question: "Форматлалын урьдчилан харагдацуудыг сонгоно уу",
        options: [
          { label: "Ялгаа", description: "Засварын ялгаа гаргах" },
          { label: "Даалгавар", description: "Даалгаврын карт гаргах" },
          { label: "Хийх зүйл", description: "Хийх зүйлийн карт гаргах" },
        ],
        multiple: true,
        custom: true,
      },
    ]
  })()

  const ref = make(state, "question", { questions })
  startTool(state, ref)

  const id = take(state, "ask", "ask")
  state.asks.set(id, { ref })

  feed(state, {
    type: "question.asked",
    properties: {
      id,
      sessionID: state.id,
      questions,
      tool: {
        messageID: ref.msg,
        callID: ref.call,
      },
    },
  } as Event)
}

async function emitFmt(state: State, kind: string, body: string, signal?: AbortSignal): Promise<boolean> {
  if (kind === "text") {
    await emitText(state, body || SAMPLE_MARKDOWN, signal)
    return true
  }

  if (kind === "markdown" || kind === "md") {
    await emitText(state, body || SAMPLE_MARKDOWN, signal)
    return true
  }

  if (kind === "table") {
    await emitText(state, body || SAMPLE_TABLE, signal)
    return true
  }

  if (kind === "reasoning") {
    await emitReasoning(state, body || "Reducer-ийн дарааллыг хадгалан дараагийн алхмуудыг төлөвлөж байна.", signal)
    return true
  }

  if (kind === "bash") {
    await emitBash(state, signal)
    return true
  }

  if (kind === "write") {
    emitWrite(state)
    return true
  }

  if (kind === "edit") {
    emitEdit(state)
    return true
  }

  if (kind === "patch") {
    emitPatch(state)
    return true
  }

  if (kind === "task") {
    emitTask(state)
    return true
  }

  if (kind === "todo") {
    emitTodo(state)
    return true
  }

  if (kind === "question") {
    emitQuestionTool(state)
    return true
  }

  if (kind === "error") {
    emitError(state, body || "үзүүлэнгийн алдааны үйл явдал")
    return true
  }

  if (kind === "mix") {
    await emitText(state, SAMPLE_MARKDOWN, signal)
    await wait(50, signal)
    await emitReasoning(state, "Форматлагчийн захын тохиолдлуудыг бодож байна [НУУЦАЛСАН].", signal)
    await wait(50, signal)
    await emitBash(state, signal)
    emitWrite(state)
    emitEdit(state)
    emitPatch(state)
    emitTask(state)
    emitTodo(state)
    emitQuestionTool(state)
    emitError(state, "үзүүлэнгийн холимог тохиолдлын алдаа")
    return true
  }

  return false
}

function intro(state: State): void {
  note(
    state.footer,
    [
      "Интерактив горимд үзүүлэнгийн налуу зурааст командууд идэвхжлээ.",
      `- /permission [kind] (${PERMISSIONS.join(", ")})`,
      `- /question [kind] (${QUESTIONS.join(", ")})`,
      `- /fmt <kind> (${KINDS.join(", ")})`,
      "Жишээнүүд:",
      "- /permission bash",
      "- /question custom",
      "- /fmt markdown",
      "- /fmt table",
      "- /fmt text өөрийн бичвэр",
    ].join("\n"),
  )
}

export function createRunDemo(input: Input) {
  const state: State = {
    id: input.sessionID,
    thinking: input.thinking,
    data: createSessionData(),
    footer: input.footer,
    limits: input.limits,
    msg: 0,
    part: 0,
    call: 0,
    perm: 0,
    ask: 0,
    perms: new Map(),
    asks: new Map(),
  }

  const start = async (): Promise<void> => {
    intro(state)
  }

  const prompt = async (line: RunPrompt, signal?: AbortSignal): Promise<boolean> => {
    const text = line.text.trim()
    const list = text.split(/\s+/)
    const cmd = list[0] || ""

    clearSubagent(state.footer)

    if (cmd === "/help") {
      intro(state)
      return true
    }

    if (cmd === "/permission") {
      const kind = permissionKind(list[1])
      if (!kind) {
        note(state.footer, `Зөвшөөрлийн төрлийг сонгоно уу: ${PERMISSIONS.join(", ")}`)
        return true
      }

      emitPermission(state, kind)
      return true
    }

    if (cmd === "/question") {
      const kind = questionKind(list[1])
      if (!kind) {
        note(state.footer, `Асуултын төрлийг сонгоно уу: ${QUESTIONS.join(", ")}`)
        return true
      }

      emitQuestion(state, kind)
      return true
    }

    if (cmd === "/fmt") {
      const kind = (list[1] || "").toLowerCase()
      const body = list.slice(2).join(" ")
      if (!kind) {
        note(state.footer, `Төрлийг сонгоно уу: ${KINDS.join(", ")}`)
        return true
      }

      const ok = await emitFmt(state, kind, body, signal)
      if (ok) {
        return true
      }

      note(state.footer, `Тодорхойгүй төрөл "${kind}". Ашиглах боломжтой: ${KINDS.join(", ")}`)
      return true
    }

    return false
  }

  const permission = (input: PermissionReply): boolean => {
    const item = state.perms.get(input.requestID)
    if (!item || !input.reply) {
      return false
    }

    state.perms.delete(input.requestID)
    const event = {
      id: `permission.replied:${input.requestID}:${Date.now()}`,
      type: "permission.replied",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
        reply: input.reply,
      },
    } satisfies Event
    feed(state, event)

    if (input.reply === "reject") {
      failTool(state, item.ref, input.message || "зөвшөөрлөөс татгалзсан")
      return true
    }

    doneTool(state, item.ref, item.done)
    return true
  }

  const questionReply = (input: QuestionReply): boolean => {
    const ask = state.asks.get(input.requestID)
    if (!ask || !input.answers) {
      return false
    }

    state.asks.delete(input.requestID)
    const event = {
      id: `question.replied:${input.requestID}:${Date.now()}`,
      type: "question.replied",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
        answers: input.answers,
      },
    } satisfies Event
    feed(state, event)
    doneTool(state, ask.ref, {
      title: "асуулт",
      output: "",
      metadata: {
        answers: input.answers,
      },
    })
    return true
  }

  const questionReject = (input: QuestionReject): boolean => {
    const ask = state.asks.get(input.requestID)
    if (!ask) {
      return false
    }

    state.asks.delete(input.requestID)
    feed(state, {
      type: "question.rejected",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
      },
    } as Event)
    failTool(state, ask.ref, "асуултаас татгалзсан")
    return true
  }

  return {
    start,
    prompt,
    permission,
    questionReply,
    questionReject,
  }
}
