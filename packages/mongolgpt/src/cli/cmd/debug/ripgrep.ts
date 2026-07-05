import { EOL } from "os"
import { Effect } from "effect"
import { Ripgrep } from "@mongolgpt/core/ripgrep"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { InstanceRef } from "@/effect/instance-ref"

export const RipgrepCommand = cmd({
  command: "rg",
  describe: "ripgrep debug хийх хэрэгслүүд",
  builder: (yargs) => yargs.command(FilesCommand).command(SearchCommand).demandCommand(),
  async handler() {},
})

const FilesCommand = effectCmd({
  command: "files",
  describe: "ripgrep ашиглан файл жагсаах",
  builder: (yargs) =>
    yargs
      .option("query", {
        type: "string",
        description: "query-ээр файл шүүх",
      })
      .option("glob", {
        type: "string",
        description: "файл тааруулах glob pattern",
      })
      .option("limit", {
        type: "number",
        description: "илэрцийн тоог хязгаарлах",
      }),
  handler: Effect.fn("Cli.debug.rg.files")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const ripgrep = yield* Ripgrep.Service
    const files = yield* ripgrep
      .glob({
        cwd: ctx.directory,
        pattern: args.glob ?? "**/*",
        limit: args.limit ?? 10_000,
      })
      .pipe(Effect.orDie)
    process.stdout.write(files.map((file) => file.path).join(EOL) + EOL)
  }),
})

const SearchCommand = effectCmd({
  command: "search <pattern>",
  describe: "ripgrep ашиглан файлын агуулга хайх",
  builder: (yargs) =>
    yargs
      .positional("pattern", {
        type: "string",
        demandOption: true,
        description: "хайлтын pattern",
      })
      .option("glob", {
        type: "array",
        description: "файлын glob pattern-ууд",
      })
      .option("limit", {
        type: "number",
        description: "илэрцийн тоог хязгаарлах",
      }),
  handler: Effect.fn("Cli.debug.rg.search")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const ripgrep = yield* Ripgrep.Service
    const results = yield* ripgrep
      .grep({
        cwd: ctx.directory,
        pattern: args.pattern,
        include: args.glob?.[0],
        limit: args.limit ?? 10_000,
      })
      .pipe(Effect.orDie)
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  }),
})
