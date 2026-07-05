import { Global } from "@mongolgpt/core/global"
import { InstallationVersion } from "@mongolgpt/core/installation/version"
import { Flag } from "@mongolgpt/core/flag/flag"
import os from "os"
import { Duration, Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { ConfigCommand } from "./config"
import { FileCommand } from "./file"
import { LSPCommand } from "./lsp"
import { RipgrepCommand } from "./ripgrep"
import { ScrapCommand } from "./scrap"
import { SkillCommand } from "./skill"
import { SnapshotCommand } from "./snapshot"
import { AgentCommand } from "./agent"
import { StartupCommand } from "./startup"
import { V2Command } from "./v2"

export const DebugCommand = cmd({
  command: "debug",
  describe: "debug болон асуудал оношлох хэрэгслүүд",
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(LSPCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(StartupCommand)
      .command(AgentCommand)
      .command(V2Command)
      .command(InfoCommand)
      .command(PathsCommand)
      .command(WaitCommand)
      .demandCommand(),
  async handler() {},
})

const WaitCommand = effectCmd({
  command: "wait",
  describe: "хязгааргүй хүлээх (debug хийхэд)",
  handler: Effect.fn("Cli.debug.wait")(function* () {
    yield* Effect.sleep(Duration.days(1))
  }),
})

const InfoCommand = effectCmd({
  command: "info",
  describe: "debug мэдээлэл харуулах",
  handler: Effect.fn("Cli.debug.info")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { ConfigPlugin } = yield* Effect.promise(() => import("@/config/plugin"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const termProgram = process.env.TERM_PROGRAM
      ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`
      : undefined
    const terminal = [termProgram, process.env.TERM].filter((item): item is string => Boolean(item)).join(" / ")

    console.log(`mongolgpt хувилбар: ${InstallationVersion}`)
    console.log(`үйлдлийн систем: ${os.type()} ${os.release()} ${os.arch()}`)
    console.log(`терминал: ${terminal || "тодорхойгүй"}`)
    console.log("plugin-ууд:")
    if (Flag.MONGOLGPT_PURE) {
      console.log("гадаад plugin-ууд идэвхгүй (--pure)")
      return
    }
    if (!config.plugin_origins?.length) {
      console.log("байхгүй")
      return
    }
    for (const plugin of config.plugin_origins) {
      console.log(`- ${ConfigPlugin.pluginSpecifier(plugin.spec)}`)
    }
  }),
})

const PathsCommand = cmd({
  command: "paths",
  describe: "глобал замуудыг харуулах (data, config, cache, state)",
  handler() {
    for (const [key, value] of Object.entries(Global.Path)) {
      console.log(key.padEnd(10), value)
    }
  },
})
