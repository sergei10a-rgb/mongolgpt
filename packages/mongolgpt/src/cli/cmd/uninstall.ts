import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "@mongolgpt/core/global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: "mongolgpt-ийг uninstall хийж холбоотой файлуудыг устгах",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "тохиргооны файлуудыг үлдээх",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "сешний өгөгдөл болон snapshots-ийг үлдээх",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "устгахгүйгээр юу устахыг харуулах",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "баталгаажуулах prompt-уудыг алгасах",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("MongolGPT uninstall хийх")

    const method = await Installation.method()
    prompts.log.info(`Суулгалтын арга: ${method}`)

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets, method)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Uninstall хийхдээ итгэлтэй байна уу?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Цуцлагдлаа")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - өөрчлөлт хийгдээгүй")
      prompts.outro("Дууслаа")
      return
    }

    await executeUninstall(method, targets)

    prompts.outro("Дууслаа")
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Өгөгдөл", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Тохиргоо", keep: args.keepConfig },
    { path: Global.Path.state, label: "Төлөв", keep: false },
  ]

  const shellConfig = method === "curl" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null

  return { directories, shellConfig, binary }
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method) {
  prompts.log.message("Дараах зүйлс устгагдана:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(үлдээж байна)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary файл: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH: ${shortenPath(targets.shellConfig)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string> = {
      npm: "npm uninstall -g mongolgpt",
      pnpm: "pnpm uninstall -g mongolgpt",
      bun: "bun remove -g mongolgpt",
      yarn: "yarn global remove mongolgpt",
      brew: "brew uninstall mongolgpt",
      choco: "choco uninstall mongolgpt",
      scoop: "scoop uninstall mongolgpt",
    }
    prompts.log.info(`  ✓ Багц: ${cmds[method] || method}`)
  }
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`${dir.label}-ийг алгасаж байна (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`${dir.label}-ийг устгаж байна...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`${dir.label}-ийг устгаж чадсангүй`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`${dir.label}-ийг устгалаа`)
  }

  if (targets.shellConfig) {
    spinner.start("Shell тохиргоог цэвэрлэж байна...")
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop("Shell тохиргоог цэвэрлэж чадсангүй", 1)
      errors.push(`Shell тохиргоо: ${err.message}`)
    } else {
      spinner.stop("Shell тохиргоог цэвэрлэлээ")
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "mongolgpt"],
      pnpm: ["pnpm", "uninstall", "-g", "mongolgpt"],
      bun: ["bun", "remove", "-g", "mongolgpt"],
      yarn: ["yarn", "global", "remove", "mongolgpt"],
      brew: ["brew", "uninstall", "mongolgpt"],
      choco: ["choco", "uninstall", "mongolgpt"],
      scoop: ["scoop", "uninstall", "mongolgpt"],
    }

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`${cmd.join(" ")} ажиллуулж байна...`)
      const result = await Process.run(method === "choco" ? ["choco", "uninstall", "mongolgpt", "-y", "-r"] : cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall амжилтгүй: гарах код ${result.code}`, 1)
        const text = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
        if (method === "choco" && text.includes("not running from an elevated command shell")) {
          prompts.log.warn(`'${cmd.join(" ")}'-г elevated command shell-ээс ажиллуулах шаардлагатай байж магадгүй`)
        } else {
          prompts.log.warn(`Гараар ажиллуулах шаардлагатай байж магадгүй: ${cmd.join(" ")}`)
        }
      } else {
        spinner.stop("Багц устгагдлаа")
      }
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("Binary-г бүрэн устгахын тулд дараахыг ажиллуулна уу:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".mongolgpt") || binDir.includes(".mongolgpt")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Зарим үйлдэл амжилтгүй боллоо:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("MongolGPT ашигласанд баярлалаа!")
}

async function getShellConfigFile(): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch(() => "")
    if (
      content.includes("# mongolgpt") ||
      content.includes("# mongolgpt") ||
      content.includes(".mongolgpt/bin") ||
      content.includes(".mongolgpt/bin")
    ) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# mongolgpt") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (
        trimmed.includes(".mongolgpt/bin") ||
        trimmed.includes(".mongolgpt/bin") ||
        trimmed.includes("fish_add_path")
      ) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") &&
        (trimmed.includes(".mongolgpt/bin") || trimmed.includes(".mongolgpt/bin"))) ||
      (trimmed.startsWith("fish_add_path") && (trimmed.includes(".mongolgpt") || trimmed.includes(".mongolgpt")))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
