import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@mongolgpt/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { CompatCommand } from "./cli/cmd/compat"
import { initializeCliAccountTokenEncryption } from "./account/cli-token-key"

const args = hideBin(process.argv)
let accountTokenEncryptionInitialization: Promise<void> | undefined

const yargsMessages = {
  "Commands:": "Командууд:",
  "Options:": "Сонголтууд:",
  "Examples:": "Жишээнүүд:",
  boolean: "логик",
  count: "тоо",
  string: "текст",
  number: "тоо",
  array: "жагсаалт",
  required: "заавал",
  default: "анхдагч",
  "default:": "анхдагч:",
  "choices:": "сонголтууд:",
  "aliases:": "өөр нэр:",
  "generated-value": "үүсгэсэн утга",
  "Not enough non-option arguments: got %s, need at least %s": {
    one: "Байрлалын аргумент дутуу: %s өгөгдсөн, дор хаяж %s хэрэгтэй",
    other: "Байрлалын аргумент дутуу: %s өгөгдсөн, дор хаяж %s хэрэгтэй",
  },
  "Too many non-option arguments: got %s, maximum of %s": {
    one: "Байрлалын аргумент хэт олон: %s өгөгдсөн, хамгийн ихдээ %s",
    other: "Байрлалын аргумент хэт олон: %s өгөгдсөн, хамгийн ихдээ %s",
  },
  "Missing argument value: %s": {
    one: "Аргументын утга дутуу: %s",
    other: "Аргументуудын утга дутуу: %s",
  },
  "Missing required argument: %s": {
    one: "Заавал өгөх аргумент дутуу: %s",
    other: "Заавал өгөх аргументууд дутуу: %s",
  },
  "Unknown argument: %s": {
    one: "Танихгүй аргумент: %s",
    other: "Танихгүй аргументууд: %s",
  },
  "Unknown command: %s": {
    one: "Танихгүй команд: %s",
    other: "Танихгүй командууд: %s",
  },
  "Invalid values:": "Хүчингүй утгууд:",
  "Argument: %s, Given: %s, Choices: %s": "Аргумент: %s, өгсөн утга: %s, сонголтууд: %s",
  "Argument check failed: %s": "Аргументын шалгалт амжилтгүй: %s",
  "Implications failed:": "Хамааралтай аргументууд дутуу:",
  "Not enough arguments following: %s": "%s-ийн дараах аргумент дутуу",
  "Invalid JSON config file: %s": "JSON тохиргооны файл хүчинтэй биш: %s",
  "Path to JSON config file": "JSON тохиргооны файлын зам",
  "Show help": "Тусламж харуулах",
  "Show version number": "Хувилбарын дугаар харуулах",
  "Did you mean %s?": "Та %s гэж хэлэх гэсэн үү?",
  "Arguments %s and %s are mutually exclusive": "%s болон %s аргументыг хамтад нь ашиглах боломжгүй",
  "Positionals:": "Байрлалын аргументууд:",
  command: "команд",
  deprecated: "хуучирсан",
  "deprecated: %s": "хуучирсан: %s",
}

const helpFailurePrefixes = ["Танихгүй аргумент", "Байрлалын аргумент дутуу", "Хүчингүй утгууд:"]

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("mongolgpt ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  // yargs-ийн төрөл зөвхөн string гэж заадаг ч дотоод y18n нь one/other бичлэгийг дэмждэг.
  .updateStrings(yargsMessages as unknown as Record<string, string>)
  .parserConfiguration({ "populate--": true })
  .scriptName("mongolgpt")
  .wrap(100)
  .help("help", "тусламж харуулах")
  .alias("help", "h")
  .version("version", "хувилбарын дугаар харуулах", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "логийг стандарт алдааны урсгал руу хэвлэх",
    type: "boolean",
  })
  .option("log-level", {
    describe: "логийн түвшин",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "гадаад нэмэлтгүй ажиллуулах",
    type: "boolean",
  })
  .middleware(async (opts) => {
    accountTokenEncryptionInitialization ??= initializeCliAccountTokenEncryption()
    await accountTokenEncryptionInitialization.catch(() => undefined)

    if (opts.printLogs) {
      process.env.MONGOLGPT_PRINT_LOGS = "1"
    }
    if (opts.logLevel) {
      process.env.MONGOLGPT_LOG_LEVEL = opts.logLevel
    }
    if (opts.pure) {
      process.env.MONGOLGPT_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.MONGOLGPT = "1"
    process.env.MONGOLGPT_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "командыг автоматаар гүйцээх бүрхүүлийн скрипт үүсгэх")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(CompatCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (msg && helpFailurePrefixes.some((prefix) => msg.startsWith(prefix))) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Гэнэтийн алдаа" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
