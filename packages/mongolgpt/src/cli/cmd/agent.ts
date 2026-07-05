import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@mongolgpt/core/global"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"

type AgentMode = "all" | "primary" | "subagent"

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

const AgentCreateCommand = effectCmd({
  command: "create",
  describe: "шинэ agent үүсгэх",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "agent файлыг үүсгэх хавтасны зам",
      })
      .option("description", {
        type: "string",
        describe: "agent юу хийх ёстойг тайлбарлах",
      })
      .option("mode", {
        type: "string",
        describe: "agent-ийн горим",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `зөвшөөрөх permission-уудыг таслалаар тусгаарласан жагсаалт (анхдагч: бүгд). Боломжтой: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "ашиглах загвар, provider/model форматтай",
      }),
  handler: Effect.fn("Cli.agent.create")(function* (args) {
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef олдсонгүй")
    const ctx = maybeCtx
    const agentSvc = yield* Agent.Service
    const runLocalEffect = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
    yield* Effect.promise(async () => {
      const cliPath = args.path
      const cliDescription = args.description
      const cliMode = args.mode as AgentMode | undefined
      const perms = args.permissions

      const isFullyNonInteractive = cliPath && cliDescription && cliMode && perms !== undefined

      if (!isFullyNonInteractive) {
        UI.empty()
        prompts.intro("Agent үүсгэх")
      }

      const project = ctx.project

      // Determine scope/path
      let targetPath: string
      if (cliPath) {
        targetPath = path.join(cliPath, "agents")
      } else {
        let scope: "global" | "project" = "global"
        if (project.vcs === "git") {
          const scopeResult = await prompts.select({
            message: "Байршил",
            options: [
              {
                label: "Одоогийн төсөл",
                value: "project" as const,
                hint: ctx.worktree,
              },
              {
                label: "Глобал",
                value: "global" as const,
                hint: Global.Path.config,
              },
            ],
          })
          if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
          scope = scopeResult
        }
        targetPath = path.join(
          scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".mongolgpt"),
          "agents",
        )
      }

      // Get description
      let description: string
      if (cliDescription) {
        description = cliDescription
      } else {
        const query = await prompts.text({
          message: "Тайлбар",
          placeholder: "Энэ agent юу хийх ёстой вэ?",
          validate: (x) => (x && x.length > 0 ? undefined : "Шаардлагатай"),
        })
        if (prompts.isCancel(query)) throw new UI.CancelledError()
        description = query
      }

      // Generate agent
      const spinner = prompts.spinner()
      spinner.start("Agent-ийн тохиргоо үүсгэж байна...")
      const model = args.model ? Provider.parseModel(args.model) : undefined
      const generated = await runLocalEffect(agentSvc.generate({ description, model })).catch((error) => {
        spinner.stop(`LLM agent үүсгэж чадсангүй: ${error.message}`, 1)
        if (isFullyNonInteractive) process.exit(1)
        throw new UI.CancelledError()
      })
      spinner.stop(`Agent ${generated.identifier} үүсгэлээ`)

      // Select permissions to allow
      let selected: string[]
      if (perms !== undefined) {
        selected = perms ? perms.split(",").map((t) => t.trim()) : AVAILABLE_PERMISSIONS
      } else {
        const result = await prompts.multiselect({
          message: "Зөвшөөрөх permission-уудыг сонгоно уу (Space дарж асааж/унтраана)",
          options: AVAILABLE_PERMISSIONS.map((permission) => ({
            label: permission,
            value: permission,
          })),
          initialValues: AVAILABLE_PERMISSIONS,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selected = result
      }

      // Get mode
      let mode: AgentMode
      if (cliMode) {
        mode = cliMode
      } else {
        const modeResult = await prompts.select({
          message: "Agent-ийн горим",
          options: [
            {
              label: "Бүгд",
              value: "all" as const,
              hint: "primary болон subagent үүрэгт хоёуланд нь ажиллана",
            },
            {
              label: "Primary",
              value: "primary" as const,
              hint: "үндсэн agent байдлаар ажиллана",
            },
            {
              label: "Subagent",
              value: "subagent" as const,
              hint: "бусад agent-ууд subagent болгон ашиглаж чадна",
            },
          ],
          initialValue: "all" as const,
        })
        if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
        mode = modeResult
      }

      // Build permissions config — deny anything not explicitly selected.
      const permissions: Record<string, "deny"> = {}
      for (const permission of AVAILABLE_PERMISSIONS) {
        if (!selected.includes(permission)) {
          permissions[permission] = "deny"
        }
      }

      // Build frontmatter
      const frontmatter: {
        description: string
        mode: AgentMode
        permission?: Record<string, "deny">
      } = {
        description: generated.whenToUse,
        mode,
      }
      if (Object.keys(permissions).length > 0) {
        frontmatter.permission = permissions
      }

      // Write file
      const content = matter.stringify(generated.systemPrompt, frontmatter)
      const filePath = path.join(targetPath, `${generated.identifier}.md`)

      await fs.mkdir(targetPath, { recursive: true })

      if (await Filesystem.exists(filePath)) {
        if (isFullyNonInteractive) {
          console.error(`Алдаа: Agent файл аль хэдийн байна: ${filePath}`)
          process.exit(1)
        }
        prompts.log.error(`Agent файл аль хэдийн байна: ${filePath}`)
        throw new UI.CancelledError()
      }

      await Filesystem.write(filePath, content)

      if (isFullyNonInteractive) {
        console.log(filePath)
      } else {
        prompts.log.success(`Agent үүсгэлээ: ${filePath}`)
        prompts.outro("Дууслаа")
      }
    })
  }),
})

const AgentListCommand = effectCmd({
  command: "list",
  describe: "боломжтой бүх agent-ийг жагсаах",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "agent-уудыг удирдах",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
