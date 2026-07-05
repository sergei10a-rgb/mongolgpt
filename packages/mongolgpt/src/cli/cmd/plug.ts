import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"

import { ConfigPaths } from "@/config/paths"
import { Global } from "@mongolgpt/core/global"
import { installPlugin, patchPluginConfig, readPluginManifest } from "../../plugin/install"
import { resolvePluginTarget } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type PlugDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "mongolgpt" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

const defaultPlugDeps: PlugDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolvePluginTarget(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  global: Global.Path.config,
}

function cause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

export function createPlugTask(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const mod = input.mod
  const force = Boolean(input.force)
  const global = Boolean(input.global)

  return async (ctx: PlugCtx) => {
    const install = dep.spinner()
    install.start("Plugin package суулгаж байна...")
    const target = await installPlugin(mod, dep)
    if (!target.ok) {
      install.stop("Суулгалт амжилтгүй", 1)
      dep.log.error(`"${mod}"-ийг суулгаж чадсангүй`)
      const hit = cause(target.error) ?? target.error
      if (hit instanceof Process.RunFailedError) {
        const lines = hit.stderr
          .toString()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
        const detail = errs[0] ?? lines.at(-1)
        if (detail) dep.log.error(detail)
        if (lines.some((line) => line.includes("No version matching"))) {
          dep.log.info("Энэ package таны npm registry-д байхгүй хувилбараас хамаарч байна.")
          dep.log.info("npm registry/auth тохиргоогоо шалгаад дахин оролдоно уу.")
        }
      }
      if (!(hit instanceof Process.RunFailedError)) {
        dep.log.error(errorMessage(hit))
      }
      return false
    }
    install.stop("Plugin package бэлэн")

    const inspect = dep.spinner()
    inspect.start("Plugin manifest уншиж байна...")
    const manifest = await readPluginManifest(target.target)
    if (!manifest.ok) {
      if (manifest.code === "manifest_read_failed") {
        inspect.stop("Manifest уншиж чадсангүй", 1)
        dep.log.error(`"${mod}" суусан ч ${manifest.file} уншиж чадсангүй`)
        dep.log.error(errorMessage(cause(manifest.error) ?? manifest.error))
        return false
      }

      if (manifest.code === "manifest_no_targets") {
        inspect.stop("Plugin target олдсонгүй", 1)
        dep.log.error(`"${mod}" package.json дотор plugin entrypoint ил гаргаагүй байна`)
        dep.log.info(
          'Дараахын аль нэгийг хүлээсэн: exports["./tui"], exports["./server"], server-ийн package.json main, эсвэл tui theme-д package.json["oc-themes"].',
        )
        return false
      }

      inspect.stop("Manifest уншиж чадсангүй", 1)
      return false
    }

    inspect.stop(`${manifest.targets.map((item) => item.kind).join(" + ")} target илэрлээ`)

    const patch = dep.spinner()
    patch.start("Plugin тохиргоо шинэчилж байна...")
    const out = await patchPluginConfig(
      {
        spec: mod,
        targets: manifest.targets,
        force,
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
      },
      dep,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop(`${out.kind} config шинэчилж чадсангүй`, 1)
        dep.log.error(`${out.file} дотор JSON буруу байна (${out.parse}, мөр ${out.line}, багана ${out.col})`)
        dep.log.info("Config файлыг засаад командыг дахин ажиллуулна уу.")
        return false
      }

      patch.stop("Plugin config шинэчилж чадсангүй", 1)
      dep.log.error(errorMessage(out.error))
      return false
    }
    patch.stop("Plugin config шинэчлэгдлээ")
    for (const item of out.items) {
      if (item.mode === "noop") {
        dep.log.info(`${item.file} дотор аль хэдийн тохируулагдсан байна`)
        continue
      }
      if (item.mode === "replace") {
        dep.log.info(`${item.file} дотор сольсон`)
        continue
      }
      dep.log.info(`${item.file} руу нэмсэн`)
    }

    dep.log.success(`${mod} суулгалаа`)
    dep.log.info(global ? `Хүрээ: global (${out.dir})` : `Хүрээ: local (${out.dir})`)
    return true
  }
}

export const PluginCommand = effectCmd({
  command: "plugin <module>",
  aliases: ["plug"],
  describe: "plugin суулгаж тохиргоог шинэчлэх",
  builder: (yargs) =>
    yargs
      .positional("module", {
        type: "string",
        describe: "npm module-ийн нэр",
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "глобал тохиргоонд суулгах",
      })
      .option("force", {
        alias: ["f"],
        type: "boolean",
        default: false,
        describe: "байгаа plugin хувилбарыг солих",
      }),
  handler: Effect.fn("Cli.plug")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(`Install plugin ${mod}`)

    const run = createPlugTask({
      mod,
      global: Boolean(args.global),
      force: Boolean(args.force),
    })

    const ctx = yield* InstanceRef
    if (!ctx) return
    const ok = yield* Effect.promise(() =>
      run({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    outro("Дууслаа")
    if (!ok) process.exitCode = 1
  }),
})
