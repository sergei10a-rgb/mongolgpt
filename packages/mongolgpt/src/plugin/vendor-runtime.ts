export * as BundledPluginRuntime from "./vendor-runtime"

import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Cause, Effect, Exit } from "effect"
import { Global } from "@mongolgpt/core/global"
import { InstallationLocal, InstallationVersion } from "@mongolgpt/core/installation/version"
import type { Npm } from "@mongolgpt/core/npm"
import * as rootRuntime from "@mongolgpt/plugin"
import * as toolRuntime from "@mongolgpt/plugin/tool"
import * as tuiRuntime from "@mongolgpt/plugin/tui"
import * as effectRuntime from "@mongolgpt/plugin/v2/effect"
import * as effectIntegrationRuntime from "@mongolgpt/plugin/v2/effect/integration"
import * as effectPluginRuntime from "@mongolgpt/plugin/v2/effect/plugin"
import * as promiseRuntime from "@mongolgpt/plugin/v2/promise"

const packageName = "@mongolgpt/plugin"
const runtimeKey = "mongolgpt.bundled-plugin-runtime.v1"
const runtimeVersion = InstallationLocal ? "0.0.0" : InstallationVersion
const runtimeSegment = runtimeVersion.replaceAll(/[^A-Za-z0-9._-]/g, "_")

const runtime = Object.freeze({
  root: rootRuntime,
  tool: toolRuntime,
  tui: tuiRuntime,
  effect: effectRuntime,
  effectIntegration: effectIntegrationRuntime,
  effectPlugin: effectPluginRuntime,
  promise: promiseRuntime,
})

const key = Symbol.for(runtimeKey)
if (Reflect.get(globalThis, key) === undefined) {
  Reflect.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: runtime,
  })
}

const runtimeLoader = `const runtime = globalThis[Symbol.for(${JSON.stringify(runtimeKey)})]
if (!runtime) throw new Error("MongolGPT-ийн багцалсан plugin runtime зөвхөн MongolGPT процесс дотор ажиллана.")
export default runtime
`

function packageFiles(version: string) {
  return new Map<string, string>([
    ["runtime.js", runtimeLoader],
    ["index.js", 'import runtime from "./runtime.js"\nexport const tool = runtime.root.tool\n'],
    ["tool.js", 'import runtime from "./runtime.js"\nexport const tool = runtime.tool.tool\n'],
    [
      "tui.js",
      [
        'import runtime from "./runtime.js"',
        "export const TuiAttentionSoundNames = runtime.tui.TuiAttentionSoundNames",
        "export const createBindingLookup = runtime.tui.createBindingLookup",
        "export const formatCommandBindings = runtime.tui.formatCommandBindings",
        "export const formatKeySequence = runtime.tui.formatKeySequence",
        "export const stringifyKeySequence = runtime.tui.stringifyKeySequence",
        "export const stringifyKeyStroke = runtime.tui.stringifyKeyStroke",
        "",
      ].join("\n"),
    ],
    ["v2/effect/index.js", 'import runtime from "../../runtime.js"\nexport const define = runtime.effect.define\n'],
    ["v2/effect/integration.js", 'import runtime from "../../runtime.js"\nvoid runtime.effectIntegration\nexport {}\n'],
    [
      "v2/effect/plugin.js",
      'import runtime from "../../runtime.js"\nexport const define = runtime.effectPlugin.define\n',
    ],
    ["v2/promise/index.js", 'import runtime from "../../runtime.js"\nexport const define = runtime.promise.define\n'],
    [
      "package.json",
      JSON.stringify(
        {
          name: packageName,
          version,
          description: "MongolGPT executable-д багцалсан plugin runtime proxy",
          type: "module",
          private: true,
          mongolgptBundledRuntime: true,
          exports: {
            ".": "./index.js",
            "./tool": "./tool.js",
            "./tui": "./tui.js",
            "./v2/effect": "./v2/effect/index.js",
            "./v2/effect/integration": "./v2/effect/integration.js",
            "./v2/effect/plugin": "./v2/effect/plugin.js",
            "./v2/promise": "./v2/promise/index.js",
          },
        },
        null,
        2,
      ) + "\n",
    ],
  ])
}

function isMissing(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}

function isAlreadyExists(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST"
}

async function lstatIfExists(target: string) {
  return fs.lstat(target).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined
    throw cause
  })
}

async function safeDirectory(root: string, relative: string) {
  const requestedRoot = path.resolve(root)
  const requestedTarget = path.resolve(requestedRoot, relative)
  const child = path.relative(requestedRoot, requestedTarget)
  if (!child || child.startsWith(`..${path.sep}`) || path.isAbsolute(child)) {
    throw new Error("MongolGPT-ийн багцалсан plugin runtime-ийн зам буруу байна")
  }

  await fs.mkdir(requestedRoot, { recursive: true })
  const resolvedRoot = await fs.realpath(requestedRoot)
  let current = resolvedRoot
  for (const segment of child.split(path.sep)) {
    current = path.join(current, segment)
    let stat = await lstatIfExists(current)
    if (!stat) {
      await fs.mkdir(current).catch((cause: unknown) => {
        if (!isAlreadyExists(cause)) throw cause
      })
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`MongolGPT-ийн багцалсан plugin runtime аюултай холбоос эсвэл файлтай замд бичихгүй: ${current}`)
    }
  }
  return current
}

async function writeIfChanged(directory: string, relative: string, content: string) {
  const parentRelative = path.dirname(relative)
  const parent = parentRelative === "." ? directory : await safeDirectory(directory, parentRelative)
  const file = path.join(parent, path.basename(relative))
  const stat = await lstatIfExists(file)
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
    throw new Error(`MongolGPT-ийн багцалсан plugin runtime аюултай холбоос эсвэл файл руу бичихгүй: ${file}`)
  }
  const existing = await fs.readFile(file, "utf8").catch(() => undefined)
  if (existing === content) return
  await fs.writeFile(file, content, "utf8")
}

async function materialize(directory: string, version: string) {
  const files = packageFiles(version)
  const manifest = files.get("package.json")
  files.delete("package.json")
  await Promise.all(Array.from(files, ([relative, content]) => writeIfChanged(directory, relative, content)))
  if (manifest) await writeIfChanged(directory, "package.json", manifest)
}

function cacheRoot() {
  const home = process.env.MONGOLGPT_TEST_HOME
  return home ? path.join(home, ".cache", "mongolgpt") : Global.Path.cache
}

async function materializeUnder(root: string, relative: string, version: string) {
  const directory = await safeDirectory(root, relative)
  await materialize(directory, version)
  return directory
}

function samePath(left: string, right: string) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function restoreTarget(directory: string, source: string, version: string) {
  const relative = path.join("node_modules", "@mongolgpt", "plugin")
  const requested = path.resolve(directory, relative)
  const stat = await lstatIfExists(requested)
  if (stat?.isSymbolicLink()) {
    const [linked, trusted] = await Promise.all([fs.realpath(requested), fs.realpath(source)])
    if (samePath(linked, trusted)) return requested
    throw new Error(`MongolGPT-ийн багцалсан plugin runtime үл таних холбоосыг зөвшөөрөхгүй: ${requested}`)
  }
  return materializeUnder(directory, relative, version)
}

export async function prepare(directory: string, options?: { cache?: string }) {
  const cache = options?.cache ?? cacheRoot()
  const sourceRelative = path.join("runtime", "plugin", runtimeSegment)
  const targetRelative = path.join("node_modules", "@mongolgpt", "plugin")
  const [source, target] = await Promise.all([
    materializeUnder(cache, sourceRelative, runtimeVersion),
    materializeUnder(directory, targetRelative, runtimeVersion),
  ])
  return { source, target, version: runtimeVersion }
}

export const install = Effect.fn("BundledPluginRuntime.install")(function* (
  npm: Pick<Npm.Interface, "install">,
  directory: string,
  options?: { cache?: string },
) {
  const prepared = yield* Effect.tryPromise({
    try: () => prepare(directory, options),
    catch: (cause) => new Error("MongolGPT-ийн багцалсан plugin runtime-ийг бэлдэж чадсангүй", { cause }),
  })
  const restore = Effect.tryPromise({
    try: () => restoreTarget(directory, prepared.source, prepared.version),
    catch: (cause) => new Error("MongolGPT-ийн багцалсан plugin runtime-ийг сэргээж чадсангүй", { cause }),
  })
  return yield* Effect.uninterruptibleMask((resume) =>
    Effect.gen(function* () {
      const installed = yield* resume(
        npm.install(directory, {
          add: [{ name: packageName, version: pathToFileURL(prepared.source).href }],
        }),
      ).pipe(Effect.exit)
      const restored = yield* restore.pipe(Effect.exit)
      if (Exit.isFailure(restored)) {
        if (Exit.isFailure(installed)) {
          return yield* Effect.failCause(Cause.combine(installed.cause, restored.cause))
        }
        return yield* Effect.failCause(restored.cause)
      }
      if (Exit.isFailure(installed)) return yield* Effect.failCause(installed.cause)
      return undefined
    }),
  )
})
