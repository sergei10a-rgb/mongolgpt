import { execFile as nodeExecFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

export type ReleaseSmokeServer = { url: string; username: string; password: string }
export type ReleaseSmokeCheck = { ok: boolean; detail?: string }
type PathPayload = { home: string; state: string; config: string; worktree: string; directory: string }
type ProjectPayload = { id: string; worktree: string }
type FileContentPayload = { type: "text" | "binary"; content: string }
type StatusPayload = { path: string; status: string }
export type ReleaseFunctionalSmokeResult = {
  capable: boolean
  summary: {
    http: Record<string, ReleaseSmokeCheck>
    terminal: ReleaseSmokeCheck
    fixture: {
      skill: boolean
      tool: boolean
      config: boolean
      mcpConfiguredDisabled: boolean
      localModelRegisteredNoCall: boolean
    }
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ExecLike = (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
export type ReleaseFunctionalSmokeOptions = { fetch?: FetchLike; exec?: ExecLike; timeoutMs?: number }

const execFile = promisify(nodeExecFile)
const marker = "MONGOLGPT_RELEASE_FUNCTIONAL_SMOKE_README_MARKER"
const mcpName = "release-functional-smoke-mcp"
const providerName = "release-functional-smoke-provider"
const modelName = "release-functional-smoke-model"

export async function runReleaseFunctionalSmoke(
  server: ReleaseSmokeServer,
  options: ReleaseFunctionalSmokeOptions = {},
): Promise<ReleaseFunctionalSmokeResult> {
  let base: URL
  try {
    base = localServerUrl(server.url)
  } catch {
    return {
      capable: false,
      summary: {
        http: { server: { ok: false, detail: "invalid localhost server URL" } },
        terminal: { ok: false, detail: "server URL rejected" },
        fixture: {
          skill: false,
          tool: false,
          config: false,
          mcpConfiguredDisabled: false,
          localModelRegisteredNoCall: false,
        },
      },
    }
  }
  const fetcher = options.fetch ?? fetch
  const run = options.exec ?? defaultExec
  const timeoutMs = smokeTimeoutMs(options.timeoutMs)
  const root = await mkdtemp(join(tmpdir(), "mongolgpt-release-smoke-"))
  const proofDir = await mkdtemp(join(tmpdir(), "mongolgpt-release-smoke-proof-"))
  const proof = join(proofDir, "terminal-proof.txt")
  const fixture = {
    skill: false,
    tool: false,
    config: false,
    mcpConfiguredDisabled: false,
    localModelRegisteredNoCall: false,
  }
  const http: Record<string, ReleaseSmokeCheck> = {}
  let terminal: ReleaseSmokeCheck = { ok: false }
  try {
    await run("git", ["init", "-q"], root)
    await run("git", ["config", "user.email", "release-smoke@example.invalid"], root)
    await run("git", ["config", "user.name", "MongolGPT Release Smoke"], root)
    await writeFile(join(root, "README.md"), "release smoke baseline\n", "utf8")
    await mkdir(join(root, ".mongolgpt", "skills", "release-functional-smoke"), { recursive: true })
    await mkdir(join(root, ".mongolgpt", "tools"), { recursive: true })
    await writeFile(
      join(root, ".mongolgpt", "skills", "release-functional-smoke", "SKILL.md"),
      "---\nname: release-functional-smoke\ndescription: Packaged Desktop skill discovery proof.\n---\nRelease smoke skill\n",
      "utf8",
    )
    fixture.skill = true
    await writeFile(
      join(root, ".mongolgpt", "tools", "desktop-smoke.ts"),
      'import { tool } from "@mongolgpt/plugin"\n\nexport default tool({\n  description: "Release smoke marker tool",\n  args: {},\n  execute: async () => "desktop smoke tool",\n})\n',
      "utf8",
    )
    fixture.tool = true
    await writeFile(
      join(root, "mongolgpt.json"),
      JSON.stringify({
        mcp: { [mcpName]: { type: "local", command: ["cmd.exe", "/d", "/c", "exit 0"], enabled: false } },
        provider: {
          [providerName]: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:9/v1" },
            models: { [modelName]: { name: modelName } },
          },
        },
      }),
      "utf8",
    )
    fixture.config = true
    await run("git", ["add", "."], root)
    await run("git", ["commit", "-q", "-m", "release smoke baseline"], root)
    await writeFile(join(root, "README.md"), `release smoke baseline\n${marker}\n`, "utf8")

    const headers = {
      Authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
      "x-mongolgpt-directory": root,
    }
    const getJson = (path: string, validate: (value: unknown) => boolean) =>
      request(fetcher, base, path, headers, "application/json", validate, timeoutMs)
    http.path = await getJson("/path", (value) => isPath(value) && value.directory === root && value.worktree === root)
    http.project = await getJson("/project/current", (value) => isProject(value) && value.worktree === root)
    http.fileContent = await getJson(
      `/file/content?path=${encodeURIComponent("README.md")}`,
      (value) => isFileContent(value) && value.content.includes(marker),
    )
    http.vcsStatus = await getJson(
      "/vcs/status",
      (value) =>
        isStatusArray(value) && value.some((item) => item.path.endsWith("README.md") && item.status === "modified"),
    )
    http.vcsDiffRaw = await request(
      fetcher,
      base,
      "/vcs/diff/raw",
      headers,
      "text/x-diff",
      (value) => typeof value === "string" && value.includes(marker),
      timeoutMs,
    )
    http.skill = await getJson(
      "/skill",
      (value) =>
        isArray(value) &&
        value.some(
          (item) => isRecord(item) && item.name === "release-functional-smoke" && typeof item.content === "string",
        ),
    )
    http.toolIds = await getJson(
      "/experimental/tool/ids",
      (value) => isToolIds(value) && value.includes("desktop-smoke"),
    )
    const mcp = await requestJsonValue(fetcher, base, "/mcp", headers, isMcpStatusMap, timeoutMs)
    http.mcp = mcp.check
    fixture.mcpConfiguredDisabled = mcp.check.ok && hasDisabledMcp(mcp.value)
    const provider = await requestJsonValue(fetcher, base, "/provider", headers, isProviderList, timeoutMs)
    http.provider = provider.check
    let providerValue = provider.value
    if (!provider.check.ok) {
      const configProviders = await requestJsonValue(
        fetcher,
        base,
        "/config/providers",
        headers,
        isProviderConfig,
        timeoutMs,
      )
      http.provider = configProviders.check
      providerValue = configProviders.value
    }
    fixture.localModelRegisteredNoCall = http.provider.ok && hasProviderModel(providerValue)

    const created = await createPty(fetcher, base, headers, root, proof, timeoutMs)
    terminal = await waitForProof(proof, marker, timeoutMs)
    await deletePty(fetcher, base, headers, created)
  } catch (error) {
    terminal = {
      ok: false,
      detail: redactSmokeError(error instanceof Error ? error.message : "probe failed", server.password),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(proofDir, { recursive: true, force: true })
  }
  const capable =
    Object.values(http).length === 9 &&
    Object.values(http).every((check) => check.ok) &&
    terminal.ok &&
    Object.values(fixture).every(Boolean)
  return { capable, summary: { http, terminal, fixture } }
}

export function validateHttpResponse(response: Pick<Response, "status" | "headers">, contentType: string): boolean {
  return (
    response.status === 200 &&
    (response.headers.get("content-type") ?? "").toLowerCase().startsWith(contentType.toLowerCase())
  )
}

export function isPath(value: unknown): value is PathPayload {
  return (
    isRecord(value) &&
    ["home", "state", "config", "worktree", "directory"].every((key) => typeof value[key] === "string")
  )
}
export function isProject(value: unknown): value is ProjectPayload {
  return isRecord(value) && typeof value.id === "string" && typeof value.worktree === "string"
}
export function isFileContent(value: unknown): value is FileContentPayload {
  return isRecord(value) && (value.type === "text" || value.type === "binary") && typeof value.content === "string"
}
export function isStatusArray(value: unknown): value is StatusPayload[] {
  return (
    isArray(value) &&
    value.every(
      (item): item is StatusPayload =>
        isRecord(item) && typeof item.path === "string" && typeof item.status === "string",
    )
  )
}
export function isToolIds(value: unknown): value is string[] {
  return isArray(value) && value.every((item) => typeof item === "string")
}
export function isMcpStatusMap(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every((item) => isRecord(item) && typeof item.status === "string")
}
export function isProviderList(
  value: unknown,
): value is { all: unknown[]; default: Record<string, unknown>; connected: unknown[] } {
  return isRecord(value) && isArray(value.all) && isRecord(value.default) && isArray(value.connected)
}
export function isProviderConfig(value: unknown): value is { providers: unknown[]; default: Record<string, unknown> } {
  return isRecord(value) && isArray(value.providers) && isRecord(value.default)
}
export function redactSmokeError(value: string, secret: string) {
  return secret ? value.split(secret).join("[redacted]") : value
}
export function smokeTimeoutMs(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 10_000
}

function localServerUrl(raw: string) {
  const url = new URL(raw)
  if (url.username || url.password) throw new Error("server URL must not contain credentials")
  if (!(["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))
    throw new Error("server must be a localhost HTTP URL")
  return url
}
async function request(
  fetcher: FetchLike,
  base: URL,
  path: string,
  headers: Record<string, string>,
  contentType: string,
  validate: (value: unknown) => boolean,
  timeoutMs: number,
): Promise<ReleaseSmokeCheck> {
  const response = await fetcher(new URL(path, base), { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!validateHttpResponse(response, contentType)) return { ok: false, detail: `HTTP ${response.status}` }
  const value = contentType.startsWith("text/") ? await response.text() : await response.json().catch(() => undefined)
  return validate(value) ? { ok: true } : { ok: false, detail: "schema validation failed" }
}
async function requestJsonValue(
  fetcher: FetchLike,
  base: URL,
  path: string,
  headers: Record<string, string>,
  validate: (value: unknown) => boolean,
  timeoutMs: number,
) {
  const response = await fetcher(new URL(path, base), { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!validateHttpResponse(response, "application/json"))
    return { check: { ok: false, detail: `HTTP ${response.status}` }, value: undefined }
  const value = await response.json().catch(() => undefined)
  return { check: validate(value) ? { ok: true } : { ok: false, detail: "schema validation failed" }, value }
}
async function createPty(
  fetcher: FetchLike,
  base: URL,
  headers: Record<string, string>,
  root: string,
  proof: string,
  timeoutMs: number,
) {
  const response = await fetcher(new URL("/pty", base), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        'git -C "%MONGOLGPT_SMOKE_ROOT%" status --short > "%MONGOLGPT_SMOKE_PROOF%" & git -C "%MONGOLGPT_SMOKE_ROOT%" diff >> "%MONGOLGPT_SMOKE_PROOF%"',
      ],
      cwd: root,
      env: { MONGOLGPT_SMOKE_ROOT: root, MONGOLGPT_SMOKE_PROOF: proof },
    }),
  })
  if (!validateHttpResponse(response, "application/json")) throw new Error(`PTY create failed: HTTP ${response.status}`)
  const value = await response.json().catch(() => undefined)
  if (!isRecord(value) || typeof value.id !== "string") throw new Error("PTY create schema validation failed")
  return value.id
}
async function deletePty(fetcher: FetchLike, base: URL, headers: Record<string, string>, id: string) {
  await fetcher(new URL(`/pty/${encodeURIComponent(id)}`, base), {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
}
async function waitForProof(file: string, expected: string, timeoutMs: number): Promise<ReleaseSmokeCheck> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await readFile(file, "utf8").catch(() => "")
    if (value.includes(expected) && value.includes("README.md")) return { ok: true }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { ok: false, detail: "terminal proof timed out" }
}
async function defaultExec(command: string, args: string[], cwd: string) {
  return execFile(command, args, { cwd, windowsHide: true, encoding: "utf8" })
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}
export function hasDisabledMcp(value: unknown) {
  return isMcpStatusMap(value) && isRecord(value[mcpName]) && value[mcpName].status === "disabled"
}
export function hasProviderModel(value: unknown) {
  if (!isProviderList(value) && !isProviderConfig(value)) return false
  const entries = isProviderList(value) ? value.all : value.providers
  return entries.some(
    (item) => isRecord(item) && item.id === providerName && isRecord(item.models) && isRecord(item.models[modelName]),
  )
}
