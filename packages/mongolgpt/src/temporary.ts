import yargs from "yargs"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { InstallationVersion } from "@mongolgpt/core/installation/version"
import { hideBin } from "yargs/helpers"
const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("mongolgpt")
  .wrap(100)
  .help("help", "тусламж харуулах")
  .alias("help", "h")
  .version("version", "хувилбарын дугаар харуулах", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "логийг stderr рүү хэвлэх",
    type: "boolean",
  })
  .option("log-level", {
    describe: "логийн түвшин",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "гадаад plugin-гүй ажиллуулах",
    type: "boolean",
  })
  .middleware((opts) => {
    if (opts.printLogs) {
      process.env.MONGOLGPT_PRINT_LOGS = "1"
      process.env.MONGOLGPT_PRINT_LOGS = "1"
    }
    if (opts.logLevel) {
      process.env.MONGOLGPT_LOG_LEVEL = opts.logLevel
      process.env.MONGOLGPT_LOG_LEVEL = opts.logLevel
    }
  })
  .command(TuiThreadCommand)
  .parse()
