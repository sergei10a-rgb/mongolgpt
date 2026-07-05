import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import * as prompts from "@clack/prompts"
import { Effect } from "effect"
import { Global } from "@mongolgpt/core/global"
import { ConfigMCPV1 } from "@mongolgpt/core/v1/config/mcp"
import { ConfigPluginV1 } from "@mongolgpt/core/v1/config/plugin"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { createPluginEntry, readPluginPackage, resolvePluginTarget } from "@/plugin/shared"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"

type CompatType = "auto" | "mcp" | "skill" | "plugin"
type CompatScope = "global" | "project"

type CompatImportArgs = {
  source?: string
  type?: CompatType
  name?: string
  scope?: CompatScope
  project?: boolean
  dryRun?: boolean
  mcpCommand?: string
  url?: string
  env?: string[]
  header?: string[]
  force?: boolean
  adapter?: boolean
}

type Operation =
  | {
      kind: "mcp"
      name: string
      config: ConfigMCPV1.Info
      source: string
    }
  | {
      kind: "skill-path"
      value: string
      source: string
    }
  | {
      kind: "skill-url"
      value: string
      source: string
    }
  | {
      kind: "plugin"
      spec: ConfigPluginV1.Spec
      source: string
      adapter?: {
        file: string
        target: string
        format: string
        original: string
      }
    }

type PatchOutcome = {
  mode: "add" | "replace" | "noop"
  operation: Operation
}

export const CompatCommand = cmd({
  command: "compat",
  describe: "Бусад AI агентын skill, plugin, MCP connector-ийг MongolGPT-д тааруулах",
  builder: (yargs) => yargs.command(CompatImportCommand).demandCommand(),
  async handler() {},
})

export const CompatImportCommand = effectCmd({
  command: ["import [source]", "add [source]", "install [source]"],
  describe: "Эх сурвалжийг таньж MongolGPT config руу хөрвүүлж нэмэх",
  builder: (yargs) =>
    yargs
      .positional("source", {
        describe: "Файл, хавтас, URL, npm package эсвэл ажиллуулах команд",
        type: "string",
      })
      .option("type", {
        describe: "Албадан таних төрөл",
        choices: ["auto", "mcp", "skill", "plugin"] as const,
        default: "auto" as const,
      })
      .option("name", {
        describe: "MCP серверийн нэр",
        type: "string",
      })
      .option("scope", {
        describe: "Хаана хадгалах",
        choices: ["global", "project"] as const,
        default: "global" as const,
      })
      .option("project", {
        describe: "Одоогийн төсөл дотор хадгалах shortcut",
        type: "boolean",
      })
      .option("dry-run", {
        describe: "Файл өөрчлөхгүйгээр юу хийхээ харуулах",
        type: "boolean",
      })
      .option("mcp-command", {
        describe: "Локал MCP сервер ажиллуулах команд",
        type: "string",
      })
      .option("url", {
        describe: "Алсын MCP URL эсвэл skill index URL",
        type: "string",
      })
      .option("env", {
        describe: "Локал MCP орчны хувьсагч KEY=VALUE",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "Алсын MCP HTTP header KEY=VALUE",
        type: "string",
        array: true,
      })
      .option("force", {
        describe: "Байгаа тохиргоог солих",
        type: "boolean",
      })
      .option("adapter", {
        describe: "JS plugin-ийг MongolGPT wrapper adapter-аар тааруулах",
        type: "boolean",
        default: true,
      })
      .example(
        'mongolgpt compat add --name higgsfield --mcp-command "npx -y @higgsfield/mcp"',
        "Claude-д зориулсан MCP командыг MongolGPT MCP config болгох",
      )
      .example(
        "mongolgpt compat import ~/.config/Claude/claude_desktop_config.json",
        "Claude Desktop MCP config-ийг MongolGPT руу хөрвүүлэх",
      )
      .example("mongolgpt compat add ./my-skill --type skill", "Skill хавтсыг MongolGPT-д бүртгэх"),
  handler: Effect.fn("Cli.compat.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef олдсонгүй")

    yield* Effect.promise(() => runCompatImport(args, ctx))
  }),
})

async function runCompatImport(args: CompatImportArgs & { "--"?: string[] }, ctx: InstanceContext) {
  prompts.intro("MongolGPT compatibility import")

  const operations = await detectOperations(args, ctx)
  if (operations.length === 0) {
    throw new Error("Таньж болох skill, plugin эсвэл MCP тохиргоо олдсонгүй")
  }

  const scope: CompatScope = args.project ? "project" : (args.scope ?? "global")
  const configPath = await resolveConfigPath(scope, ctx)
  const prepared = await prepareCompatibilityOperations({
    operations,
    ctx,
    configPath,
    writeAdapters: !args.dryRun,
    adapter: args.adapter !== false,
    force: Boolean(args.force),
  })

  for (const operation of prepared) {
    prompts.log.info(describeOperation(operation))
  }

  if (args.dryRun) {
    prompts.log.info(`Бичих config: ${configPath}`)
    prompts.outro("Dry run дууслаа. Файл өөрчлөгдөөгүй.")
    return
  }

  const outcomes = await patchConfigFile(configPath, prepared, Boolean(args.force))
  for (const outcome of outcomes) {
    if (outcome.mode === "noop") {
      prompts.log.info(`Өмнө нь байсан: ${describeOperation(outcome.operation)}`)
      continue
    }
    prompts.log.success(`${outcome.mode === "replace" ? "Солилоо" : "Нэмлээ"}: ${describeOperation(outcome.operation)}`)
  }
  prompts.outro(`Дууслаа. Config: ${configPath}`)
}

async function detectOperations(
  args: CompatImportArgs & { "--"?: string[] },
  ctx: InstanceContext,
): Promise<Operation[]> {
  const type = args.type ?? "auto"
  const env = parseKeyValueList(args.env ?? [], "env")
  const headers = parseKeyValueList(args.header ?? [], "header")
  const commandTokens = commandFromArgs(args)

  if (commandTokens.length > 0) {
    return [
      {
        kind: "mcp",
        name: args.name ?? inferMcpNameFromCommand(commandTokens),
        config: {
          type: "local",
          command: commandTokens,
          ...(Object.keys(env).length > 0 ? { environment: env } : {}),
        },
        source: commandTokens.join(" "),
      },
    ]
  }

  if (args.url) {
    return operationFromUrl(args.url, type, args.name, headers)
  }

  const source = args.source?.trim()
  if (!source) {
    throw new Error("--mcp-command, --url эсвэл source хэрэгтэй")
  }

  if (isHttpUrl(source)) {
    return operationFromUrl(source, type, args.name, headers)
  }

  const resolved = path.resolve(ctx.directory, source)
  const stat = await Filesystem.statAsync(resolved)
  if (stat?.isDirectory()) {
    return detectDirectory(resolved, source, type, ctx)
  }
  if (stat?.isFile()) {
    return detectFile(resolved, source, type, ctx)
  }

  if (type === "skill") {
    return [{ kind: "skill-path", value: source, source }]
  }
  if (type === "plugin") {
    return [{ kind: "plugin", spec: source, source }]
  }
  if (type === "mcp") {
    const command = looksLikePackage(source) ? ["npx", "-y", source] : splitShellCommand(source)
    return [
      {
        kind: "mcp",
        name: args.name ?? inferMcpNameFromCommand(command),
        config: {
          type: "local",
          command,
          ...(Object.keys(env).length > 0 ? { environment: env } : {}),
        },
        source,
      },
    ]
  }

  if (looksLikeCommand(source)) {
    const command = splitShellCommand(source)
    return [
      {
        kind: "mcp",
        name: args.name ?? inferMcpNameFromCommand(command),
        config: {
          type: "local",
          command,
          ...(Object.keys(env).length > 0 ? { environment: env } : {}),
        },
        source,
      },
    ]
  }

  if (looksLikeMcpPackage(source)) {
    const command = ["npx", "-y", source]
    return [
      {
        kind: "mcp",
        name: args.name ?? inferMcpNameFromCommand(command),
        config: {
          type: "local",
          command,
          ...(Object.keys(env).length > 0 ? { environment: env } : {}),
        },
        source,
      },
    ]
  }

  if (looksLikePackage(source)) {
    return [{ kind: "plugin", spec: source, source }]
  }

  throw new Error(`Эх сурвалж олдсонгүй эсвэл танигдсангүй: ${source}`)
}

function operationFromUrl(url: string, type: CompatType, name: string | undefined, headers: Record<string, string>) {
  if (type === "skill" || (type === "auto" && !looksLikeMcpUrl(url))) {
    return [{ kind: "skill-url" as const, value: url, source: url }]
  }
  if (type === "plugin") {
    return [{ kind: "plugin" as const, spec: url, source: url }]
  }
  return [
    {
      kind: "mcp" as const,
      name: name ?? inferNameFromUrl(url),
      config: {
        type: "remote" as const,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      source: url,
    },
  ]
}

async function detectFile(
  file: string,
  original: string,
  type: CompatType,
  ctx: InstanceContext,
): Promise<Operation[]> {
  const basename = path.basename(file).toLowerCase()
  if (type === "skill" || basename === "skill.md" || file.endsWith(".md")) {
    return [{ kind: "skill-path", value: configPathFor(ctx, path.dirname(file)), source: original }]
  }

  if (basename === "package.json" && (type === "auto" || type === "plugin")) {
    return [{ kind: "plugin", spec: configPathFor(ctx, path.dirname(file)), source: original }]
  }

  if (type === "plugin") {
    return [{ kind: "plugin", spec: configPathFor(ctx, file), source: original }]
  }

  const text = await Filesystem.readText(file)
  const data = parseConfigDocument(text, file)
  const fromJson = operationsFromConfigObject(data, original)
  if (fromJson.length > 0) return fromJson

  return []
}

async function detectDirectory(
  dir: string,
  original: string,
  type: CompatType,
  ctx: InstanceContext,
): Promise<Operation[]> {
  if (type === "skill" || (await hasSkillFile(dir))) {
    return [{ kind: "skill-path", value: configPathFor(ctx, dir), source: original }]
  }

  if (type === "plugin" && (await Filesystem.exists(path.join(dir, "package.json")))) {
    return [{ kind: "plugin", spec: configPathFor(ctx, dir), source: original }]
  }

  for (const candidate of commonMcpConfigFiles(dir)) {
    if (!(await Filesystem.exists(candidate))) continue
    const text = await Filesystem.readText(candidate)
    const data = parseConfigDocument(text, candidate)
    const operations = operationsFromConfigObject(data, candidate)
    if (operations.length > 0) return operations
  }

  if (type === "plugin" || (await Filesystem.exists(path.join(dir, "package.json")))) {
    return [{ kind: "plugin", spec: configPathFor(ctx, dir), source: original }]
  }

  return []
}

async function prepareCompatibilityOperations(input: {
  operations: Operation[]
  ctx: InstanceContext
  configPath: string
  writeAdapters: boolean
  adapter: boolean
  force: boolean
}) {
  if (!input.adapter) return input.operations

  const prepared: Operation[] = []
  for (const operation of input.operations) {
    if (operation.kind !== "plugin") {
      prepared.push(operation)
      continue
    }

    const adapted = await preparePluginAdapter(operation, input).catch((error) => {
      prompts.log.warn(
        `Plugin adapter үүсгэж чадсангүй, эх plugin-ийг шууд нэмнэ: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return operation
    })
    prepared.push(adapted)
  }
  return prepared
}

async function preparePluginAdapter(
  operation: Extract<Operation, { kind: "plugin" }>,
  input: {
    ctx: InstanceContext
    configPath: string
    writeAdapters: boolean
    force: boolean
  },
): Promise<Operation> {
  const original = pluginSpecString(operation.spec)
  if (!original || isHttpUrl(original)) return operation

  const target = input.writeAdapters
    ? await resolvePluginImportTarget(original, input.ctx)
    : {
        importTarget: original,
        format: "planned-js",
      }

  const configDir = path.dirname(input.configPath)
  const adapterDir = path.join(configDir, "plugins", "adapters")
  const adapterName = `${sanitizeName(packageNameToId(original))}-${stableHash(original).slice(0, 8)}`
  const adapterFile = path.join(adapterDir, `${adapterName}.compat.js`)
  const adapterSpec = normalizeSlashes(`./${path.relative(configDir, adapterFile)}`)

  if (input.writeAdapters && (input.force || !(await Filesystem.exists(adapterFile)))) {
    await Filesystem.write(
      adapterFile,
      pluginAdapterTemplate({
        id: adapterName,
        target: target.importTarget,
        toolImport: resolvePluginRuntimeImport(),
      }),
    )
  }

  return {
    ...operation,
    spec: adapterSpec,
    adapter: {
      file: adapterFile,
      target: target.importTarget,
      format: target.format,
      original,
    },
  }
}

async function resolvePluginImportTarget(
  spec: string,
  ctx: InstanceContext,
): Promise<{ importTarget: string; format: string }> {
  if (isLocalPluginSpec(spec)) {
    const local = resolveLocalPluginSpec(spec, ctx)
    const stat = await Filesystem.statAsync(local)
    if (!stat) throw new Error(`Plugin файл/хавтас олдсонгүй: ${spec}`)
    if (stat.isDirectory()) {
      return {
        importTarget: pathToFileURL(await resolveDirectoryEntrypoint(local)).href,
        format: "local-directory-js",
      }
    }
    return {
      importTarget: pathToFileURL(local).href,
      format: "local-file-js",
    }
  }

  const target = await resolvePluginTarget(spec)
  const entry = await createPluginEntry(spec, target, "server").catch(() => undefined)
  if (entry?.entry) {
    return {
      importTarget: entry.entry,
      format: "npm-js",
    }
  }

  const pkg = await readPluginPackage(target).catch(() => undefined)
  if (pkg) {
    return {
      importTarget: pathToFileURL(await resolveDirectoryEntrypoint(pkg.dir)).href,
      format: "npm-js",
    }
  }

  const direct = target.startsWith("file://") ? target : pathToFileURL(target).href
  return {
    importTarget: direct,
    format: "npm-js",
  }
}

async function resolveDirectoryEntrypoint(dir: string) {
  const pkgFile = path.join(dir, "package.json")
  if (await Filesystem.exists(pkgFile)) {
    const pkg = await Filesystem.readJson<Record<string, unknown>>(pkgFile)
    const fromPkg = packageEntrypoint(pkg, dir)
    if (fromPkg && (await Filesystem.exists(fromPkg))) return fromPkg
  }

  for (const file of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]) {
    const candidate = path.join(dir, file)
    if (await Filesystem.exists(candidate)) return candidate
  }

  throw new Error(`Plugin хавтас entrypoint-гүй байна: ${dir}`)
}

function packageEntrypoint(pkg: Record<string, unknown>, dir: string) {
  const exports = pkg.exports
  if (typeof exports === "string") return path.resolve(dir, exports)
  if (isRecord(exports)) {
    const root = exports["."]
    const value = exportEntrypointValue(root) ?? exportEntrypointValue(exports)
    if (value) return path.resolve(dir, value)
  }

  for (const key of ["module", "main"]) {
    const value = pkg[key]
    if (typeof value === "string" && value.trim()) return path.resolve(dir, value)
  }
}

function exportEntrypointValue(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!isRecord(input)) return
  for (const key of ["import", "default", "require"]) {
    const value = input[key]
    if (typeof value === "string") return value
  }
}

function isLocalPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
}

function resolveLocalPluginSpec(spec: string, ctx: InstanceContext) {
  if (spec.startsWith("file://")) return fileURLToPath(spec)
  if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return path.resolve(spec)

  const fromWorktree = path.resolve(ctx.worktree, spec)
  if (Filesystem.stat(fromWorktree)) return fromWorktree
  return path.resolve(ctx.directory, spec)
}

function pluginSpecString(spec: ConfigPluginV1.Spec) {
  return Array.isArray(spec) ? spec[0] : spec
}

function operationsFromConfigObject(data: unknown, source: string): Operation[] {
  const operations: Operation[] = []
  for (const [name, raw] of entriesFromMcpConfigObject(data)) {
    const config = normalizeMcpServer(raw)
    if (!config) continue
    operations.push({ kind: "mcp", name: sanitizeName(name), config, source })
  }

  for (const spec of pluginSpecsFromConfigObject(data)) {
    operations.push({ kind: "plugin", spec, source })
  }

  for (const value of skillPathsFromConfigObject(data)) {
    operations.push({ kind: "skill-path", value, source })
  }

  for (const value of skillUrlsFromConfigObject(data)) {
    operations.push({ kind: "skill-url", value, source })
  }

  return operations
}

function entriesFromMcpConfigObject(data: unknown): Array<[string, unknown]> {
  if (!isRecord(data)) return []
  const direct = data.mcpServers
  if (isRecord(direct)) return Object.entries(direct)

  const mcp = data.mcp
  if (!isRecord(mcp)) return []
  if (isRecord(mcp.servers)) return Object.entries(mcp.servers)

  return Object.entries(mcp).filter(
    ([, value]) => isRecord(value) && ("type" in value || "command" in value || "url" in value),
  )
}

function normalizeMcpServer(raw: unknown): ConfigMCPV1.Info | undefined {
  if (!isRecord(raw)) return

  if (raw.type === "remote" || typeof raw.url === "string") {
    const url = typeof raw.url === "string" ? raw.url.trim() : ""
    if (!url) return
    const headers = stringRecord(raw.headers)
    return {
      type: "remote",
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(raw.enabled === false || raw.disabled === true ? { enabled: false } : {}),
      ...(positiveNumber(raw.timeout) ? { timeout: raw.timeout } : {}),
    }
  }

  const command = commandFromMcpObject(raw)
  if (command.length === 0) return

  const environment = {
    ...stringRecord(raw.environment),
    ...stringRecord(raw.env),
  }

  return {
    type: "local",
    command,
    ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
    ...(raw.enabled === false || raw.disabled === true ? { enabled: false } : {}),
    ...(positiveNumber(raw.timeout) ? { timeout: raw.timeout } : {}),
  }
}

function commandFromMcpObject(raw: Record<string, unknown>): string[] {
  const command = raw.command
  const args = raw.args

  if (Array.isArray(command) && command.every((item) => typeof item === "string")) return command

  const suffix =
    Array.isArray(args) && args.every((item) => typeof item === "string")
      ? args
      : typeof args === "string"
        ? splitShellCommand(args)
        : []

  if (typeof command === "string") return [command, ...suffix].filter(Boolean)
  return []
}

function pluginSpecsFromConfigObject(data: unknown): ConfigPluginV1.Spec[] {
  if (!isRecord(data)) return []
  const plugin = Array.isArray(data.plugin) ? data.plugin : Array.isArray(data.plugins) ? data.plugins : []
  return plugin.filter(
    (item): item is ConfigPluginV1.Spec =>
      typeof item === "string" ||
      (Array.isArray(item) && typeof item[0] === "string" && (item.length === 1 || isRecord(item[1]))),
  )
}

function skillPathsFromConfigObject(data: unknown): string[] {
  if (!isRecord(data)) return []
  const skills = data.skills
  if (Array.isArray(skills))
    return skills.filter((item): item is string => typeof item === "string" && !isHttpUrl(item))
  if (!isRecord(skills) || !Array.isArray(skills.paths)) return []
  return skills.paths.filter((item): item is string => typeof item === "string")
}

function skillUrlsFromConfigObject(data: unknown): string[] {
  if (!isRecord(data)) return []
  const skills = data.skills
  if (Array.isArray(skills)) return skills.filter((item): item is string => typeof item === "string" && isHttpUrl(item))
  if (!isRecord(skills) || !Array.isArray(skills.urls)) return []
  return skills.urls.filter((item): item is string => typeof item === "string")
}

async function patchConfigFile(configPath: string, operations: Operation[], force: boolean): Promise<PatchOutcome[]> {
  const raw = await Filesystem.readText(configPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "{}"
    throw err
  })

  let text = stripBom(raw.trim() ? raw : "{}")
  let data = parseConfigDocument(text, configPath)
  const outcomes: PatchOutcome[] = []

  for (const operation of operations) {
    const outcome = patchOperation(text, data, operation, force)
    text = outcome.text
    data = parseConfigDocument(text, configPath)
    outcomes.push({
      mode: outcome.mode,
      operation,
    })
  }

  if (outcomes.some((item) => item.mode !== "noop")) {
    await Filesystem.write(configPath, text)
  }

  return outcomes
}

function patchOperation(
  text: string,
  data: unknown,
  operation: Operation,
  force: boolean,
): { mode: PatchOutcome["mode"]; text: string } {
  if (operation.kind === "mcp") {
    const existing = isRecord(data) && isRecord(data.mcp) ? data.mcp[operation.name] : undefined
    if (existing !== undefined && !force) return { mode: "noop", text }
    return {
      mode: existing === undefined ? "add" : "replace",
      text: patchJsonc(text, ["mcp", operation.name], operation.config),
    }
  }

  if (operation.kind === "plugin") {
    return patchArrayValue(text, data, ["plugin"], operation.spec, force)
  }

  const section = operation.kind === "skill-path" ? "paths" : "urls"
  return patchArrayValue(text, data, ["skills", section], operation.value, force)
}

function patchArrayValue(
  text: string,
  data: unknown,
  pointer: Array<string | number>,
  value: unknown,
  force: boolean,
): { mode: PatchOutcome["mode"]; text: string } {
  const current = getPointer(data, pointer)
  if (!Array.isArray(current)) {
    return {
      mode: "add",
      text: patchJsonc(text, pointer, [value]),
    }
  }

  const index = current.findIndex((item) => sameConfigValue(item, value))
  if (index >= 0) {
    if (!force) return { mode: "noop", text }
    return {
      mode: "replace",
      text: patchJsonc(text, [...pointer, index], value),
    }
  }

  return {
    mode: "add",
    text: patchJsonc(text, [...pointer, current.length], value, true),
  }
}

function patchJsonc(text: string, pointer: Array<string | number>, value: unknown, insert = false) {
  return applyEdits(
    text,
    modify(text, pointer, value, {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
      },
      isArrayInsertion: insert,
    }),
  )
}

function parseConfigDocument(text: string, source: string): unknown {
  const input = stripBom(text)
  const errors: ParseError[] = []
  const data = parseJsonc(input, errors, { allowTrailingComma: true })
  if (errors.length === 0) return data
  const err = errors[0]
  const lines = input.substring(0, err.offset).split("\n")
  throw new Error(
    `${source} JSON/JSONC уншихад алдаа гарлаа (${lines.length}:${lines[lines.length - 1].length + 1}, ${printParseErrorCode(err.error)})`,
  )
}

function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function resolveConfigPath(scope: CompatScope, ctx: InstanceContext) {
  const dir = scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".mongolgpt")
  const candidates = [
    path.join(dir, "mongolgpt.jsonc"),
    path.join(dir, "mongolgpt.json"),
    path.join(dir, "config.json"),
  ]
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
  return candidates[0]
}

function commandFromArgs(args: CompatImportArgs & { "--"?: string[] }) {
  if (args["--"]?.length) return args["--"]
  if (args.mcpCommand) return splitShellCommand(args.mcpCommand)
  return []
}

function splitShellCommand(input: string): string[] {
  const out: string[] = []
  let token = ""
  let quote: "'" | `"` | undefined
  let escaped = false

  const push = () => {
    if (!token) return
    out.push(token)
    token = ""
  }

  for (const char of input.trim()) {
    if (escaped) {
      token += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
      continue
    }
    if (char === "'" || char === `"`) {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    token += char
  }

  if (quote) throw new Error("Командын quote хаагдаагүй байна")
  push()
  return out
}

function parseKeyValueList(values: string[], kind: string) {
  return Object.fromEntries(
    values.map((entry) => {
      const index = entry.indexOf("=")
      if (index < 1) throw new Error(`Буруу ${kind}: ${entry}. KEY=VALUE хэлбэртэй байх ёстой`)
      return [entry.slice(0, index), entry.slice(index + 1)]
    }),
  )
}

function stringRecord(input: unknown): Record<string, string> {
  if (!isRecord(input)) return {}
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function positiveNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input > 0
}

function getPointer(data: unknown, pointer: Array<string | number>) {
  return pointer.reduce<unknown>((current, key) => {
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    return current[key as keyof typeof current]
  }, data)
}

function sameConfigValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function hasSkillFile(dir: string) {
  if (await Filesystem.exists(path.join(dir, "SKILL.md"))) return true
  if (await Filesystem.exists(path.join(dir, "skills"))) return true
  if (await Filesystem.exists(path.join(dir, "skill"))) return true
  return false
}

function commonMcpConfigFiles(dir: string) {
  return [
    path.join(dir, "claude_desktop_config.json"),
    path.join(dir, "mcp.json"),
    path.join(dir, ".mcp.json"),
    path.join(dir, ".cursor", "mcp.json"),
    path.join(dir, "cursor", "mcp.json"),
  ]
}

function looksLikeCommand(input: string) {
  if (/\s/.test(input)) return true
  const first = splitShellCommand(input)[0]
  return ["npx", "bun", "node", "python", "python3", "uvx", "docker", "pnpm", "yarn"].includes(first)
}

function looksLikePackage(input: string) {
  return /^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w*^~.-]+)?$/.test(input)
}

function looksLikeMcpPackage(input: string) {
  return looksLikePackage(input) && /(^@modelcontextprotocol\/|mcp|model-context-protocol)/i.test(input)
}

function looksLikeMcpUrl(input: string) {
  try {
    const url = new URL(input)
    return /(^mcp\.|\/mcp(?:\/|$)|modelcontextprotocol)/i.test(`${url.hostname}${url.pathname}`)
  } catch {
    return false
  }
}

function isHttpUrl(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function inferMcpNameFromCommand(command: string[]) {
  const candidate = command.find((token, index) => {
    if (index === 0) return false
    if (token.startsWith("-")) return false
    if (["x", "dlx", "exec", "run", "run-script", "node", "python", "python3"].includes(token)) return false
    return true
  })
  return sanitizeName(candidate ? packageNameToId(candidate) : command[0] || "mcp")
}

function packageNameToId(input: string) {
  const raw = input.replace(/^npm:/, "").replace(/^github:/, "")
  if (raw.startsWith("@")) {
    const [scopeRaw, packageRaw = ""] = raw.split("/")
    const scope = scopeRaw.slice(1)
    const packageName = packageRaw.replace(/@[^@/]+$/, "")
    if (!packageName || ["mcp", "server", "mcp-server"].includes(packageName)) return scope
    return cleanupPackageName(packageName)
  }
  const name = raw.split("/").pop() ?? raw
  return cleanupPackageName(name.replace(/@[^@/]+$/, ""))
}

function cleanupPackageName(input: string) {
  return input
    .replace(/^@/, "")
    .replace(/^mcp-server-/, "")
    .replace(/^server-/, "")
    .replace(/-mcp-server$/, "")
    .replace(/-mcp$/, "")
}

function inferNameFromUrl(input: string) {
  const url = new URL(input)
  const last = url.pathname.split("/").filter(Boolean).pop()
  if (last && last !== "mcp") return sanitizeName(last)
  return sanitizeName(url.hostname.replace(/^mcp\./, "").split(".")[0])
}

function sanitizeName(input: string) {
  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return name || "mcp"
}

function stableHash(input: string) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function configPathFor(ctx: InstanceContext, value: string) {
  const resolved = path.resolve(value)
  const worktree = path.resolve(ctx.worktree)
  const relative = path.relative(worktree, resolved)
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return normalizeSlashes(relative || ".")
  return normalizeSlashes(resolved)
}

function normalizeSlashes(input: string) {
  return input.replaceAll("\\", "/")
}

function resolvePluginRuntimeImport() {
  try {
    return import.meta.resolve("@mongolgpt/plugin")
  } catch {
    return "@mongolgpt/plugin"
  }
}

function pluginAdapterTemplate(input: { id: string; target: string; toolImport: string }) {
  return `// Generated by MongolGPT compatibility importer. Do not edit by hand unless you are replacing the adapter.
import { tool } from ${JSON.stringify(input.toolImport)}

const target = ${JSON.stringify(input.target)}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function pickFunction(value, names) {
  if (typeof value === "function") return value
  if (!isRecord(value)) return undefined
  for (const name of names) {
    if (typeof value[name] === "function") return value[name].bind(value)
  }
}

function zodFromJsonSchema(schema) {
  const z = tool.schema
  if (!isRecord(schema)) return z.any()
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((item) => typeof item === "string")
    if (values.length > 0) return values.length === 1 ? z.literal(values[0]) : z.enum(values)
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return z.any()
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return z.any()
  switch (schema.type) {
    case "string":
      return z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(zodFromJsonSchema(schema.items))
    case "object":
      return z.object(jsonSchemaProperties(schema)).passthrough()
    default:
      return z.any()
  }
}

function jsonSchemaProperties(schema) {
  const properties = isRecord(schema?.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const field = zodFromJsonSchema(value)
      return [key, required.has(key) ? field : field.optional()]
    }),
  )
}

function argsFrom(value) {
  if (!isRecord(value)) return {}
  if (isRecord(value.args)) return value.args
  if (isRecord(value.parameters)) return jsonSchemaProperties(value.parameters)
  if (isRecord(value.inputSchema)) return jsonSchemaProperties(value.inputSchema)
  if (isRecord(value.schema)) return jsonSchemaProperties(value.schema)
  return {}
}

function formatToolResult(result) {
  if (typeof result === "string") return result
  if (!isRecord(result)) return JSON.stringify(result ?? null)
  if (typeof result.output === "string") return result
  if (typeof result.text === "string") return result.text
  if (typeof result.message === "string") return result.message
  if (Array.isArray(result.content)) {
    const output = result.content
      .map((part) => {
        if (typeof part === "string") return part
        if (isRecord(part) && typeof part.text === "string") return part.text
        return JSON.stringify(part)
      })
      .join("\\n")
    return output
  }
  return JSON.stringify(result, null, 2)
}

function normalizeTool(name, value) {
  const execute = pickFunction(value, ["execute", "handler", "run", "call", "invoke"])
  if (!execute) return undefined
  const description =
    (isRecord(value) && (value.description || value.summary || value.title)) || \`\${name} compatibility tool\`

  return tool({
    description: String(description),
    args: argsFrom(value),
    execute: async (args, context) => formatToolResult(await execute(args, context)),
  })
}

function registerTools(target, hooks) {
  if (!target) return
  const tools = isRecord(target) ? target.tool ?? target.tools : undefined
  if (!tools) return
  hooks.tool ??= {}
  if (Array.isArray(tools)) {
    for (const item of tools) {
      if (!isRecord(item)) continue
      const name = String(item.name || item.id || "")
      if (!name) continue
      const next = normalizeTool(name, item)
      if (next) hooks.tool[name] = next
    }
    return
  }
  if (isRecord(tools)) {
    for (const [name, value] of Object.entries(tools)) {
      const next = normalizeTool(name, value)
      if (next) hooks.tool[name] = next
    }
  }
}

function mergeNativeHooks(hooks, value) {
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (key === "tool" || key === "tools") continue
    if (typeof item === "function" || isRecord(item)) hooks[key] = item
  }
}

function attachHookAliases(hooks, value) {
  if (!isRecord(value)) return
  const event = pickFunction(value, ["event", "onEvent"])
  if (event) hooks.event = async (input) => event(input)

  const config = pickFunction(value, ["config", "onConfig"])
  if (config) hooks.config = async (input) => config(input)

  const beforeCommand = pickFunction(value, ["beforeCommand", "onCommandBefore"])
  if (beforeCommand) hooks["command.execute.before"] = async (input, output) => beforeCommand(input, output)

  const beforeTool = pickFunction(value, ["beforeTool", "onToolBefore"])
  if (beforeTool) hooks["tool.execute.before"] = async (input, output) => beforeTool(input, output)

  const afterTool = pickFunction(value, ["afterTool", "onToolAfter"])
  if (afterTool) hooks["tool.execute.after"] = async (input, output) => afterTool(input, output)
}

function adapterContext(input, options, hooks) {
  const subscriptions = []
  const registerTool = (name, definition) => {
    const next = normalizeTool(name, definition)
    if (!next) return
    hooks.tool ??= {}
    hooks.tool[name] = next
  }
  return {
    ...input,
    options,
    subscriptions,
    registerTool,
    addTool: registerTool,
    tools: {
      register: registerTool,
      add: registerTool,
    },
  }
}

async function runForeignPlugin(candidate, mod, input, options, hooks) {
  const context = adapterContext(input, options, hooks)
  const results = []

  if (isRecord(candidate) && typeof candidate.server === "function") {
    results.push(await candidate.server(context, options))
  } else if (typeof candidate === "function") {
    results.push(await candidate(context, options))
  }

  for (const name of ["activate", "setup", "init", "register"]) {
    const fn = isRecord(candidate) && typeof candidate[name] === "function" ? candidate[name].bind(candidate) : undefined
    if (fn) results.push(await fn(context, options))
  }

  for (const value of [mod, candidate, ...results]) {
    mergeNativeHooks(hooks, value)
    registerTools(value, hooks)
    attachHookAliases(hooks, value)
  }

  const disposers = []
  for (const value of [candidate, ...results]) {
    const dispose = pickFunction(value, ["dispose", "deactivate", "stop", "cleanup"])
    if (dispose) disposers.push(dispose)
  }
  if (disposers.length) {
    const previous = hooks.dispose
    hooks.dispose = async () => {
      if (previous) await previous()
      for (const dispose of disposers) await dispose()
    }
  }

  return hooks
}

export default {
  id: ${JSON.stringify(`compat-${input.id}`)},
  async server(input, options) {
    const mod = await import(target)
    const candidate = mod.default ?? mod
    const hooks = {}
    return runForeignPlugin(candidate, mod, input, options, hooks)
  },
}
`
}

function describeOperation(operation: Operation) {
  switch (operation.kind) {
    case "mcp":
      return `MCP "${operation.name}" (${operation.config.type === "remote" ? operation.config.url : operation.config.command.join(" ")})`
    case "skill-path":
      return `skill path "${operation.value}"`
    case "skill-url":
      return `skill URL "${operation.value}"`
    case "plugin":
      if (operation.adapter) {
        return `plugin adapter "${operation.adapter.original}" -> "${pluginSpecString(operation.spec)}"`
      }
      return `plugin "${Array.isArray(operation.spec) ? operation.spec[0] : operation.spec}"`
  }
}
