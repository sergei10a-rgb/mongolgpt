import { EOL } from "os"
import { Effect } from "effect"
import { FileSystem } from "@mongolgpt/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@mongolgpt/core/location-services"
import { Location } from "@mongolgpt/core/location"
import { AbsolutePath, RelativePath } from "@mongolgpt/core/schema"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

const filesystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
    Effect.provide(locationServiceMapLayer),
  )

const FileSearchCommand = effectCmd({
  command: "search <query>",
  describe: "query-ээр файл хайх",
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      demandOption: true,
      description: "хайлтын query",
    }),
  handler: Effect.fn("Cli.debug.file.search")(function* (args) {
    const results = yield* Effect.orDie(filesystem(FileSystem.Service.use((svc) => svc.find({ query: args.query }))))
    process.stdout.write(results.map((item) => item.path).join(EOL) + EOL)
  }),
})

const FileReadCommand = effectCmd({
  command: "read <path>",
  describe: "файлын агуулгыг JSON хэлбэрээр унших",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "унших файлын зам",
    }),
  handler: Effect.fn("Cli.debug.file.read")(function* (args) {
    const file = yield* filesystem(FileSystem.Service.use((svc) => svc.read({ path: RelativePath.make(args.path) })))
    process.stdout.write(
      JSON.stringify(
        { content: Buffer.from(file.content).toString("base64"), encoding: "base64", mime: file.mime },
        null,
        2,
      ) + EOL,
    )
  }),
})

const FileListCommand = effectCmd({
  command: "list <path>",
  describe: "хавтас доторх файлуудыг жагсаах",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "жагсаах файлын зам",
    }),
  handler: Effect.fn("Cli.debug.file.list")(function* (args) {
    const files = yield* filesystem(FileSystem.Service.use((svc) => svc.list({ path: RelativePath.make(args.path) })))
    process.stdout.write(JSON.stringify(files, null, 2) + EOL)
  }),
})

export const FileCommand = cmd({
  command: "file",
  describe: "файлын систем debug хийх хэрэгслүүд",
  builder: (yargs) =>
    yargs.command(FileReadCommand).command(FileListCommand).command(FileSearchCommand).demandCommand(),
  async handler() {},
})
