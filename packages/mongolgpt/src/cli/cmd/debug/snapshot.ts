import { Effect } from "effect"
import { Snapshot } from "../../../snapshot"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

export const SnapshotCommand = cmd({
  command: "snapshot",
  describe: "snapshot debug хийх хэрэгслүүд",
  builder: (yargs) => yargs.command(TrackCommand).command(PatchCommand).command(DiffCommand).demandCommand(),
  async handler() {},
})

const TrackCommand = effectCmd({
  command: "track",
  describe: "одоогийн snapshot төлөвийг дагах",
  handler: Effect.fn("Cli.debug.snapshot.track")(function* () {
    const out = yield* Snapshot.Service.use((svc) => svc.track())
    console.log(out)
  }),
})

const PatchCommand = effectCmd({
  command: "patch <hash>",
  describe: "snapshot hash-ийн patch харуулах",
  builder: (yargs) =>
    yargs.positional("hash", {
      type: "string",
      description: "hash",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.debug.snapshot.patch")(function* (args) {
    const out = yield* Snapshot.Service.use((svc) => svc.patch(args.hash))
    console.log(out)
  }),
})

const DiffCommand = effectCmd({
  command: "diff <hash>",
  describe: "snapshot hash-ийн diff харуулах",
  builder: (yargs) =>
    yargs.positional("hash", {
      type: "string",
      description: "hash",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.debug.snapshot.diff")(function* (args) {
    const out = yield* Snapshot.Service.use((svc) => svc.diff(args.hash))
    console.log(out)
  }),
})
