import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@mongolgpt/core/installation/version"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "mongolgpt-ийг хамгийн сүүлийн эсвэл тодорхой хувилбар руу upgrade хийх",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "upgrade хийх хувилбар, жишээ нь '0.1.48' эсвэл 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "ашиглах суулгалтын арга",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`MongolGPT ${process.execPath} дээр суусан бөгөөд package manager-аар удирдагдаж байж магадгүй`)
      const install = await prompts.select({
        message: "Гэсэн ч суулгах уу?",
        options: [
          { label: "Тийм", value: true },
          { label: "Үгүй", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Дууслаа")
        return
      }
    }
    prompts.log.info("Ашиглаж буй арга: " + method)
    const target = args.target ? args.target.replace(/^mongolgpt-/, "").replace(/^v/, "") : await Installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(`mongolgpt upgrade алгаслаа: ${target} аль хэдийн суусан байна`)
      prompts.outro("Дууслаа")
      return
    }

    prompts.log.info(`${InstallationVersion} → ${target} руу`)
    const spinner = prompts.spinner()
    spinner.start("Upgrade хийж байна...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade амжилтгүй", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Терминалыг Administrator эрхээр ажиллуулаад дахин оролдоно уу")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Дууслаа")
      return
    }
    spinner.stop("Upgrade дууслаа")
    prompts.outro("Дууслаа")
  },
}
