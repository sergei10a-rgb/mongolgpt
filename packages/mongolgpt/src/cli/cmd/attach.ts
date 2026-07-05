import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@mongolgpt/tui/util/error"
import { validateSession } from "../tui/validate-session"
import { ServerAuth } from "@/server/auth"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "ажиллаж буй mongolgpt серверт холбогдох",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "ажиллуулах хавтас",
      })
      .option("continue", {
        alias: ["c"],
        describe: "сүүлийн сешнийг үргэлжлүүлэх",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "үргэлжлүүлэх сешний ID",
      })
      .option("fork", {
        type: "boolean",
        describe: "үргэлжлүүлэхдээ сешнийг fork хийх (--continue эсвэл --session-тэй ашиглана)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "үндсэн баталгаажуулалтын нууц үг (анхдагч нь MONGOLGPT_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "үндсэн баталгаажуулалтын хэрэглэгчийн нэр (анхдагч нь MONGOLGPT_SERVER_USERNAME эсвэл 'mongolgpt')",
      })
      .option("mini", {
        type: "boolean",
        describe: "жижиг интерактив интерфэйс эхлүүлэх",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "resume болон resize-ийн дараа mini сешний түүхийг дахин харуулахгүй",
      })
      .option("replay-limit", {
        type: "number",
        describe: "mini replay-д харагдах түүхийг хамгийн шинэ N мессежээр хязгаарлах",
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay дэмжигдэхгүй; replay анхдагчаар идэвхтэй")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()

    if (args.mini) {
      const { runMini } = await import("./run")
      await runMini({
        attach: args.url,
        directory,
        password: args.password,
        username: args.username,
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} нь --mini шаарддаг`)
      process.exitCode = 1
      return
    }

    const { TuiConfig } = await import("@/config/tui")
    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork нь --continue эсвэл --session шаарддаг")
      process.exitCode = 1
      return
    }

    const headers = ServerAuth.headers({ password: args.password, username: args.username })
    const config = await TuiConfig.get()

    try {
      await validateSession({
        url: args.url,
        sessionID: args.session,
        directory,
        headers,
      })
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return
    }

    const { Effect } = await import("effect")
    const { run } = await import("../tui/layer")
    const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
    await Effect.runPromise(
      run({
        url: args.url,
        config,
        pluginHost: createLegacyTuiPluginHost(),
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers,
      }),
    )
  },
})
