import * as prompts from "@clack/prompts"
import { Effect } from "effect"
import {
  applyCompatImport,
  describeCompatOperation,
  planCompatImport,
  type CompatImportInput,
  type CompatPatchOutcome,
} from "@/compat"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"

export type CompatImportArgs = CompatImportInput

export const CompatCommand = cmd({
  command: "compat",
  describe: "Бусад AI агентын skill, plugin, MCP connector-ийг MongolGPT-д тааруулах",
  builder: (yargs) => yargs.command(CompatImportCommand).demandCommand(),
  async handler() {},
})

export const CompatImportCommand = effectCmd({
  command: ["import [source]", "add [source]", "install [source]"],
  describe: "Эх сурвалжийг таньж MongolGPT config руу хөрвүүлж нэмэх",
  builder: (yargs) =>
    yargs
      .positional("source", {
        describe: "Файл, хавтас, URL, npm package эсвэл ажиллуулах команд",
        type: "string",
      })
      .option("type", {
        describe: "Албадан таних төрөл",
        choices: ["auto", "mcp", "skill", "plugin"] as const,
        default: "auto" as const,
      })
      .option("name", {
        describe: "MCP серверийн нэр",
        type: "string",
      })
      .option("scope", {
        describe: "Хаана хадгалах",
        choices: ["global", "project"] as const,
        default: "global" as const,
      })
      .option("project", {
        describe: "Одоогийн төсөл дотор хадгалах shortcut",
        type: "boolean",
      })
      .option("dry-run", {
        describe: "Файл өөрчлөхгүйгээр юу хийхээ харуулах",
        type: "boolean",
      })
      .option("mcp-command", {
        describe: "Локал MCP сервер ажиллуулах команд",
        type: "string",
      })
      .option("url", {
        describe: "Алсын MCP URL эсвэл skill index URL",
        type: "string",
      })
      .option("env", {
        describe: "Локал MCP орчны хувьсагч KEY=VALUE",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "Алсын MCP HTTP header KEY=VALUE",
        type: "string",
        array: true,
      })
      .option("force", {
        describe: "Байгаа тохиргоог солих",
        type: "boolean",
      })
      .option("adapter", {
        describe: "JS plugin-ийг MongolGPT adapter-аар тааруулах",
        type: "boolean",
        default: true,
      })
      .example(
        'mongolgpt compat add --name higgsfield --mcp-command "npx -y @higgsfield/mcp"',
        "Claude-д зориулсан MCP командыг MongolGPT MCP config болгох",
      )
      .example(
        "mongolgpt compat import ~/.config/Claude/claude_desktop_config.json",
        "Claude Desktop MCP config-ийг MongolGPT руу хөрвүүлэх",
      )
      .example("mongolgpt compat add ./my-skill --type skill", "Skill хавтсыг MongolGPT-д бүртгэх"),
  handler: Effect.fn("Cli.compat.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef олдсонгүй")

    yield* Effect.promise(() => runCompatImport(args, ctx))
  }),
})

async function runCompatImport(args: CompatImportInput, ctx: InstanceContext) {
  prompts.intro("MongolGPT нийцүүлэн импортлох")

  const plan = args.dryRun
    ? await planCompatImport(args, ctx, { writeAdapters: false })
    : await applyCompatImport(args, ctx)

  for (const warning of plan.warnings) {
    prompts.log.warn(warning)
  }

  for (const operation of plan.prepared) {
    prompts.log.info(describeCompatOperation(operation))
  }

  if (args.dryRun) {
    prompts.log.info(`Бичих config: ${plan.configPath}`)
    prompts.outro("Dry run дууслаа. Файл өөрчлөгдөөгүй.")
    return
  }

  for (const outcome of plan.outcomes) {
    logOutcome(outcome)
  }
  prompts.outro(`Дууслаа. Config: ${plan.configPath}`)
}

function logOutcome(outcome: CompatPatchOutcome) {
  if (outcome.mode === "noop") {
    prompts.log.info(`Өмнө нь байсан: ${describeCompatOperation(outcome.operation)}`)
    return
  }
  prompts.log.success(
    `${outcome.mode === "replace" ? "Солилоо" : "Нэмлээ"}: ${describeCompatOperation(outcome.operation)}`,
  )
}
