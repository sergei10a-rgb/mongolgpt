import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { parseDocument as parseYamlDocument } from "yaml"
import { Global } from "@mongolgpt/core/global"
import { ConfigMCPV1 } from "@mongolgpt/core/v1/config/mcp"
import { ConfigPluginV1 } from "@mongolgpt/core/v1/config/plugin"
import type { InstanceContext } from "@/project/instance-context"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { createPluginEntry, readPluginPackage, resolvePluginTarget } from "@/plugin/shared"

export type CompatType = "auto" | "mcp" | "skill" | "plugin"
export type CompatScope = "global" | "project"

export type CompatImportArgs = {
  source?: string
  type?: CompatType
  name?: string
  scope?: CompatScope
  project?: boolean
  dryRun?: boolean
  mcpCommand?: string
  url?: string
  env?: readonly string[]
  header?: readonly string[]
  force?: boolean
  adapter?: boolean
}

export type CompatImportInput = CompatImportArgs & { "--"?: readonly string[] }

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

class CompatSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompatSecurityError"
  }
}

export type CompatOperation = Operation
export type CompatPatchOutcome = PatchOutcome

export type CompatPlan = {
  scope: CompatScope
  configPath: string
  operations: Operation[]
  prepared: Operation[]
  descriptions: string[]
  warnings: string[]
  outcomes: PatchOutcome[]
  existingConfigText: string
  nextConfigText: string
  configExists: boolean
}

export type CompatPlanOptions = {
  writeAdapters?: boolean
  adapter?: boolean
  force?: boolean
  onAdapterError?: (operation: Extract<Operation, { kind: "plugin" }>, error: unknown) => void
}

// Native MongolGPT compatibility importer API. CLI, desktop, and server surfaces share this layer.

export async function detectCompatOperations(
  args: CompatImportInput,
  ctx: InstanceContext,
): Promise<CompatOperation[]> {
  return detectOperations(args, ctx)
}

export async function resolveCompatConfigPath(scope: CompatScope, ctx: InstanceContext) {
  return resolveConfigPath(scope, ctx)
}

export async function planCompatImport(
  args: CompatImportInput,
  ctx: InstanceContext,
  options: CompatPlanOptions = {},
): Promise<CompatPlan> {
  const warnings: string[] = []
  const operations = await detectOperations(args, ctx, warnings)
  if (operations.length === 0) {
    throw new Error("Танигдах skill, plugin эсвэл MCP тохиргоо олдсонгүй")
  }

  const scope: CompatScope = args.project ? "project" : (args.scope ?? "global")
  const configPath = await resolveConfigPath(scope, ctx)
  warnings.push(...mcpConflictWarnings(operations))
  const prepared = await prepareCompatibilityOperations({
    operations,
    ctx,
    configPath,
    writeAdapters: options.writeAdapters ?? false,
    adapter: options.adapter ?? args.adapter !== false,
    force: options.force ?? Boolean(args.force),
    onAdapterError:
      options.onAdapterError ??
      ((operation, error) => {
        warnings.push(
          `Plugin adapter үүсгэж чадсангүй (${pluginSpecString(operation.spec) || operation.source}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }),
  })
  const config = await readConfigText(configPath)
  const preview = patchCompatConfigText(config.text, prepared, options.force ?? Boolean(args.force), configPath)

  return {
    scope,
    configPath,
    operations,
    prepared,
    descriptions: prepared.map(describeCompatOperation),
    warnings: [...new Set(warnings)],
    outcomes: preview.outcomes,
    existingConfigText: config.text,
    nextConfigText: preview.text,
    configExists: config.exists,
  }
}

export async function applyCompatImport(
  args: CompatImportInput,
  ctx: InstanceContext,
  options: CompatPlanOptions = {},
): Promise<CompatPlan> {
  // Validate and preview the config before any adapter file can be written.
  await planCompatImport(args, ctx, { ...options, writeAdapters: false })
  const plan = await planCompatImport(args, ctx, { ...options, writeAdapters: options.writeAdapters ?? true })
  if (plan.outcomes.some((item) => item.mode !== "noop")) {
    await Filesystem.write(plan.configPath, plan.nextConfigText)
  }
  return plan
}

async function detectOperations(
  args: CompatImportInput,
  ctx: InstanceContext,
  warnings: string[] = [],
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
    throw new Error("--mcp-command, --url эсвэл source шаардлагатай")
  }

  if (isHttpUrl(source)) {
    return operationFromUrl(source, type, args.name, headers)
  }

  const resolved = path.resolve(ctx.directory, source)
  const stat = await Filesystem.statAsync(resolved)
  if (stat?.isDirectory()) {
    return detectDirectory(resolved, source, type, ctx, warnings)
  }
  if (stat?.isFile()) {
    return detectFile(resolved, source, type, ctx, warnings)
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
  warnings: string[],
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
  const fromJson = operationsFromConfigObject(data, original, warnings)
  if (fromJson.length > 0) return fromJson

  return []
}

async function detectDirectory(
  dir: string,
  original: string,
  type: CompatType,
  ctx: InstanceContext,
  warnings: string[],
): Promise<Operation[]> {
  if (type === "skill") {
    return [{ kind: "skill-path", value: configPathFor(ctx, dir), source: original }]
  }

  if (type === "plugin") {
    return [{ kind: "plugin", spec: configPathFor(ctx, dir), source: original }]
  }

  const operations: Operation[] = []
  if (type === "auto" && (await hasSkillFile(dir))) {
    operations.push({ kind: "skill-path", value: configPathFor(ctx, dir), source: original })
  }

  if (type === "auto" || type === "mcp") {
    for (const candidate of commonMcpConfigFiles(dir)) {
      if (!(await Filesystem.exists(candidate))) continue
      const text = await Filesystem.readText(candidate)
      const data = parseConfigDocument(text, candidate)
      operations.push(...operationsFromConfigObject(data, candidate, warnings))
    }
  }

  if (type === "auto" && (await Filesystem.exists(path.join(dir, "package.json")))) {
    operations.push({ kind: "plugin", spec: configPathFor(ctx, dir), source: original })
  }

  return operations
}

async function prepareCompatibilityOperations(input: {
  operations: Operation[]
  ctx: InstanceContext
  configPath: string
  writeAdapters: boolean
  adapter: boolean
  force: boolean
  onAdapterError?: (operation: Extract<Operation, { kind: "plugin" }>, error: unknown) => void
}) {
  if (!input.adapter) return input.operations

  const prepared: Operation[] = []
  for (const operation of input.operations) {
    if (operation.kind !== "plugin") {
      prepared.push(operation)
      continue
    }

    const adapted = await preparePluginAdapter(operation, input).catch((error) => {
      if (error instanceof CompatSecurityError) throw error
      input.onAdapterError?.(operation, error)
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
  if (await isExistingLocalPluginSpec(spec, ctx)) {
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
  if (typeof exports === "string") return resolvePackageEntrypoint(dir, exports)
  if (isRecord(exports)) {
    const root = exports["."]
    const value = exportEntrypointValue(root) ?? exportEntrypointValue(exports)
    if (value) return resolvePackageEntrypoint(dir, value)
  }

  for (const key of ["module", "main"]) {
    const value = pkg[key]
    if (typeof value === "string" && value.trim()) return resolvePackageEntrypoint(dir, value)
  }
}

function resolvePackageEntrypoint(dir: string, value: string) {
  const resolved = path.resolve(dir, value)
  const relative = path.relative(path.resolve(dir), resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CompatSecurityError(`Plugin entrypoint хавтаснаасаа гадагш зааж байна: ${value}`)
  }
  return resolved
}

function exportEntrypointValue(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!isRecord(input)) return
  for (const key of ["import", "default", "require"]) {
    const value = input[key]
    if (typeof value === "string") return value
  }
}

async function isExistingLocalPluginSpec(spec: string, ctx: InstanceContext) {
  if (isLocalPluginSpec(spec)) return true
  if (await Filesystem.statAsync(path.resolve(ctx.worktree, spec))) return true
  if (await Filesystem.statAsync(path.resolve(ctx.directory, spec))) return true
  return false
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

function operationsFromConfigObject(data: unknown, source: string, warnings: string[] = []): Operation[] {
  const operations: Operation[] = []
  for (const { name, raw, dialect } of entriesFromMcpConfigObject(data, source)) {
    const config = normalizeMcpServer(raw, dialect)
    if (!config) continue
    warnings.push(...unsupportedMcpWarnings(name, raw, dialect, source))
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

type McpConfigDialect = "generic" | "claude" | "codex" | "goose" | "hermes"

function entriesFromMcpConfigObject(
  data: unknown,
  source: string,
): Array<{ name: string; raw: unknown; dialect: McpConfigDialect }> {
  if (!isRecord(data)) return []
  const direct = data.mcpServers
  if (isRecord(direct)) return mcpEntries(direct, "claude")

  const snake = data.mcp_servers
  if (isRecord(snake)) {
    const dialect = path.extname(source).toLowerCase() === ".toml" ? "codex" : "hermes"
    return mcpEntries(snake, dialect)
  }

  const extensions = data.extensions
  if (isRecord(extensions)) return mcpEntries(extensions, "goose")

  const mcp = data.mcp
  if (!isRecord(mcp)) return []
  if (isRecord(mcp.servers)) return mcpEntries(mcp.servers, "generic")

  return mcpEntries(
    Object.fromEntries(
      Object.entries(mcp).filter(
        ([, value]) => isRecord(value) && ("type" in value || "command" in value || "url" in value),
      ),
    ),
    "generic",
  )
}

function mcpEntries(data: Record<string, unknown>, dialect: McpConfigDialect) {
  return Object.entries(data).map(([name, raw]) => ({ name, raw, dialect }))
}

const supportedMcpFields: Record<McpConfigDialect, ReadonlySet<string>> = {
  generic: new Set([
    "type",
    "command",
    "args",
    "cwd",
    "environment",
    "env",
    "enabled",
    "disabled",
    "url",
    "headers",
    "timeout",
  ]),
  claude: new Set(["type", "command", "args", "cwd", "env", "enabled", "disabled", "url", "headers", "timeout"]),
  codex: new Set(["command", "args", "cwd", "env", "enabled", "url", "http_headers", "tool_timeout_sec"]),
  goose: new Set(["name", "description", "type", "cmd", "args", "envs", "enabled", "uri", "url", "headers", "timeout"]),
  hermes: new Set(["type", "command", "args", "cwd", "env", "enabled", "disabled", "url", "headers", "timeout"]),
}

function unsupportedMcpWarnings(name: string, raw: unknown, dialect: McpConfigDialect, source: string) {
  if (!isRecord(raw) || dialect === "generic" || dialect === "claude") return []
  const unsupported = Object.keys(raw).filter((key) => !supportedMcpFields[dialect].has(key))
  if (unsupported.length === 0) return []
  return [
    `${dialectLabel(dialect)} MCP "${name}"-ийн MongolGPT-д шууд таарахгүй талбаруудыг алгаслаа (${unsupported.sort().join(", ")}): ${source}`,
  ]
}

function dialectLabel(dialect: McpConfigDialect) {
  switch (dialect) {
    case "codex":
      return "Codex"
    case "goose":
      return "Goose"
    case "hermes":
      return "Hermes"
    case "claude":
      return "Claude"
    case "generic":
      return "MCP"
  }
  return dialect
}

function mcpConflictWarnings(operations: Operation[]) {
  const first = new Map<string, Extract<Operation, { kind: "mcp" }>>()
  const warnings: string[] = []
  for (const operation of operations) {
    if (operation.kind !== "mcp") continue
    const previous = first.get(operation.name)
    if (!previous) {
      first.set(operation.name, operation)
      continue
    }
    if (sameConfigValue(previous.config, operation.config)) continue
    warnings.push(
      `MCP "${operation.name}" нэр ${previous.source} болон ${operation.source} эх сурвалжид өөр тохиргоотой байна. --force ашиглаагүй үед эхний тохиргоог хадгална.`,
    )
  }
  return warnings
}

function normalizeMcpServer(raw: unknown, dialect: McpConfigDialect): ConfigMCPV1.Info | undefined {
  if (!isRecord(raw)) return undefined

  const remoteUrl = typeof raw.url === "string" ? raw.url : typeof raw.uri === "string" ? raw.uri : ""
  if (raw.type === "remote" || remoteUrl) {
    const url = remoteUrl.trim()
    if (!url) return undefined
    const headers = {
      ...stringRecord(raw.headers),
      ...stringRecord(raw.http_headers),
    }
    const timeout = mcpTimeout(raw, dialect)
    return {
      type: "remote",
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(raw.enabled === false || raw.disabled === true ? { enabled: false } : {}),
      ...(timeout ? { timeout } : {}),
    }
  }

  const command = commandFromMcpObject(raw)
  if (command.length === 0) return undefined

  const environment = {
    ...stringRecord(raw.environment),
    ...stringRecord(raw.env),
    ...stringRecord(raw.envs),
  }
  const timeout = mcpTimeout(raw, dialect)

  return {
    type: "local",
    command,
    ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
    ...(raw.enabled === false || raw.disabled === true ? { enabled: false } : {}),
    ...(timeout ? { timeout } : {}),
  }
}

function commandFromMcpObject(raw: Record<string, unknown>): string[] {
  const command = raw.command ?? raw.cmd
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

function mcpTimeout(raw: Record<string, unknown>, dialect: McpConfigDialect): number | undefined {
  if (positiveNumber(raw.tool_timeout_sec)) return secondsToMilliseconds(raw.tool_timeout_sec)
  if (!positiveNumber(raw.timeout)) return undefined
  return dialect === "goose" || dialect === "hermes" ? secondsToMilliseconds(raw.timeout) : raw.timeout
}

function secondsToMilliseconds(seconds: number) {
  const milliseconds = seconds * 1000
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
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

async function readConfigText(configPath: string) {
  const result = await Filesystem.readText(configPath)
    .then((text) => ({ text, exists: true }))
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return { text: "{}", exists: false }
      throw err
    })
  return {
    text: stripBom(result.text.trim() ? result.text : "{}"),
    exists: result.exists,
  }
}

export function patchCompatConfigText(
  raw: string,
  operations: Operation[],
  force = false,
  source = "<config>",
): { text: string; outcomes: PatchOutcome[] } {
  let text = stripBom(raw.trim() ? raw : "{}")
  let data = parseConfigDocument(text, source)
  const outcomes: PatchOutcome[] = []

  for (const operation of operations) {
    const outcome = patchOperation(text, data, operation, force)
    text = outcome.text
    data = parseConfigDocument(text, source)
    outcomes.push({
      mode: outcome.mode,
      operation,
    })
  }

  return { text, outcomes }
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

const maxCompatConfigBytes = 2 * 1024 * 1024

function parseConfigDocument(text: string, source: string): unknown {
  const input = stripBom(text)
  if (Buffer.byteLength(input, "utf8") > maxCompatConfigBytes) {
    throw new Error(`${source} тохиргооны файл 2 MiB хэмжээнээс хэтэрсэн тул импортлохгүй`)
  }
  const extension = path.extname(source).toLowerCase()
  if (extension === ".toml") {
    try {
      return parseToml(input)
    } catch (error) {
      throw new Error(`${source} TOML уншихад алдаа гарлаа: ${errorMessage(error)}`, { cause: error })
    }
  }
  if (extension === ".yaml" || extension === ".yml") {
    const document = parseYamlDocument(input, { uniqueKeys: true })
    const error = document.errors[0]
    if (error) throw new Error(`${source} YAML уншихад алдаа гарлаа: ${error.message}`)
    return document.toJS({ maxAliasCount: 100 })
  }
  const errors: ParseError[] = []
  const data = parseJsonc(input, errors, { allowTrailingComma: true })
  if (errors.length === 0) return data
  const err = errors[0]
  const lines = input.substring(0, err.offset).split("\n")
  throw new Error(
    `${source} JSON/JSONC уншихад алдаа гарлаа (${lines.length}:${lines[lines.length - 1].length + 1}, ${printParseErrorCode(err.error)})`,
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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

function commandFromArgs(args: CompatImportInput) {
  if (args["--"]?.length) return [...args["--"]]
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

function parseKeyValueList(values: readonly string[], kind: string) {
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
  const basename = path.basename(dir).toLowerCase()
  const direct = [
    path.join(dir, "claude_desktop_config.json"),
    path.join(dir, "mcp.json"),
    path.join(dir, ".mcp.json"),
    path.join(dir, ".cursor", "mcp.json"),
    path.join(dir, "cursor", "mcp.json"),
    path.join(dir, ".codex", "config.toml"),
    path.join(dir, ".hermes", "config.yaml"),
    path.join(dir, ".hermes", "config.yml"),
    path.join(dir, ".config", "goose", "config.yaml"),
    path.join(dir, ".config", "goose", "config.yml"),
    path.join(dir, ".goose", "config.yaml"),
    path.join(dir, ".goose", "config.yml"),
  ]
  if (basename === ".codex" || basename === "codex") direct.push(path.join(dir, "config.toml"))
  if ([".hermes", "hermes", ".goose", "goose"].includes(basename)) {
    direct.push(path.join(dir, "config.yaml"), path.join(dir, "config.yml"))
  }
  return [...new Set(direct)]
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

export function describeCompatOperation(operation: Operation) {
  switch (operation.kind) {
    case "mcp":
      return `MCP "${operation.name}" (${operation.config.type === "remote" ? operation.config.url : operation.config.command.join(" ")})`
    case "skill-path":
      return `ур чадварын зам "${operation.value}"`
    case "skill-url":
      return `ур чадварын URL "${operation.value}"`
    case "plugin":
      if (operation.adapter) {
        return `залгаасны тааруулагч "${operation.adapter.original}" -> "${pluginSpecString(operation.spec)}"`
      }
      return `залгаас "${Array.isArray(operation.spec) ? operation.spec[0] : operation.spec}"`
  }
}
