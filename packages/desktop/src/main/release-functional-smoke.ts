import { execFile as nodeExecFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

export type ReleaseSmokeServer = { url: string; username: string; password: string; smokeProof?: string }
export type ReleaseSmokeCheck = { ok: boolean; detail?: string }
type PathPayload = { home: string; state: string; config: string; worktree: string; directory: string }
type ProjectPayload = { id: string; worktree: string }
type FileContentPayload = { type: "text" | "binary"; content: string }
type StatusPayload = { file: string; status: string }
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
      localModelInference: boolean
    }
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ExecLike = (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
export type ReleaseFunctionalSmokeOptions = {
  fetch?: FetchLike
  exec?: ExecLike
  timeoutMs?: number
  externalPtyProof?: string
}

const execFile = promisify(nodeExecFile)
const marker = "MONGOLGPT_RELEASE_FUNCTIONAL_SMOKE_README_MARKER"
const externalPtyMarker = "MONGOLGPT_PACKAGED_PTY_OK"
const mcpName = "release-functional-smoke-mcp"
const providerName = "release-functional-smoke-provider"
const modelName = "release-functional-smoke-model"
const localModelApiKey = "release-smoke-local-key"
const localModelPrompt = "MongolGPT Desktop local model smoke"
const localModelReply = "MongolGPT Desktop локал загварын smoke амжилттай"

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
          localModelInference: false,
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
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
    "x-mongolgpt-directory": root,
    ...(server.smokeProof ? { "x-mongolgpt-desktop-smoke-proof": server.smokeProof } : {}),
  }
  const fixture = {
    skill: false,
    tool: false,
    config: false,
    mcpConfiguredDisabled: false,
    localModelInference: false,
  }
  const http: Record<string, ReleaseSmokeCheck> = {}
  let terminal: ReleaseSmokeCheck = { ok: false }
  let localModel: Awaited<ReturnType<typeof startLocalModelServer>> | undefined
  try {
    localModel = await startLocalModelServer()
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
      'export default {\n  description: "Release smoke marker tool",\n  args: {},\n  execute: async () => "desktop smoke tool",\n}\n',
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
            options: { apiKey: localModelApiKey, baseURL: localModel.url },
            models: {
              [modelName]: {
                name: modelName,
                tool_call: true,
                limit: { context: 8_192, output: 2_048 },
                cost: { input: 0, output: 0 },
              },
            },
          },
        },
      }),
      "utf8",
    )
    fixture.config = true
    await run("git", ["add", "."], root)
    await run("git", ["commit", "-q", "-m", "release smoke baseline"], root)
    await writeFile(join(root, "README.md"), `release smoke baseline\n${marker}\n`, "utf8")

    const getJson = (path: string, validate: (value: unknown) => boolean) =>
      request(fetcher, base, path, headers, "application/json", validate, timeoutMs)
    const pathInfo = await requestJsonValue(fetcher, base, "/path", headers, isPath, timeoutMs)
    http.path = pathInfo.check
    if (pathInfo.check.ok && isPath(pathInfo.value)) {
      const [directory, worktree] = await Promise.all([
        sameLocalPath(pathInfo.value.directory, root),
        sameLocalPath(pathInfo.value.worktree, root),
      ])
      http.path = directory && worktree ? { ok: true } : { ok: false, detail: "path identity mismatch" }
    }
    const project = await requestJsonValue(fetcher, base, "/project/current", headers, isProject, timeoutMs)
    http.project = project.check
    if (project.check.ok && isProject(project.value)) {
      http.project = (await sameLocalPath(project.value.worktree, root))
        ? { ok: true }
        : { ok: false, detail: "project path identity mismatch" }
    }
    http.fileContent = await getJson(
      `/file/content?path=${encodeURIComponent("README.md")}`,
      (value) => isFileContent(value) && value.content.includes(marker),
    )
    http.vcsStatus = await getJson(
      "/vcs/status",
      (value) =>
        isStatusArray(value) && value.some((item) => item.file.endsWith("README.md") && item.status === "modified"),
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
    const providerRegistered = http.provider.ok && hasProviderModel(providerValue)
    const session = await postJsonValue(
      fetcher,
      base,
      "/session",
      headers,
      { title: "Desktop local model release smoke" },
      isSession,
      timeoutMs,
    )
    http.session = session.check
    if (session.check.ok && isSession(session.value)) {
      const sessionID = encodeURIComponent(session.value.id)
      const prompt = await postJsonValue(
        fetcher,
        base,
        `/session/${sessionID}/message`,
        headers,
        {
          agent: "build",
          model: { providerID: providerName, modelID: modelName },
          parts: [{ type: "text", text: localModelPrompt }],
        },
        (value) => hasMessageText(value, localModelReply),
        timeoutMs,
      )
      http.localModelPrompt = prompt.check
      http.localModelMessages = await getJson(`/session/${sessionID}/message`, (value) =>
        hasMessageText(value, localModelReply),
      )
    } else {
      http.localModelPrompt = { ok: false, detail: "session creation failed" }
      http.localModelMessages = { ok: false, detail: "session creation failed" }
    }
    fixture.localModelInference =
      providerRegistered &&
      http.localModelPrompt.ok &&
      http.localModelMessages.ok &&
      hasLocalModelRequest(localModel.request())

    const externalPtyProof = options.externalPtyProof ?? process.env.MONGOLGPT_DESKTOP_SMOKE_EXTERNAL_PTY_PROOF
    if (externalPtyProof) {
      terminal = await readExternalPtyProof(externalPtyProof)
    } else {
      const created = await createPty(fetcher, base, headers, root, proof, timeoutMs)
      terminal = await waitForProof(proof, marker, timeoutMs)
      await deletePty(fetcher, base, headers, created)
    }
  } catch (error) {
    const detail = [server.password, server.smokeProof]
      .filter((secret): secret is string => Boolean(secret))
      .reduce(
        (message, secret) => redactSmokeError(message, secret),
        error instanceof Error ? error.message : "probe failed",
      )
    terminal = {
      ok: false,
      detail,
    }
  } finally {
    await disposeInstance(fetcher, base, headers, timeoutMs)
    await localModel?.close()
    await removeSmokeDirectory(root)
    await removeSmokeDirectory(proofDir)
  }
  const capable =
    Object.values(http).length === 12 &&
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
        isRecord(item) && typeof item.file === "string" && typeof item.status === "string",
    )
  )
}
export function isToolIds(value: unknown): value is string[] {
  return isArray(value) && value.every((item) => typeof item === "string")
}
export function isSession(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
}
export function hasMessageText(value: unknown, text: string) {
  return JSON.stringify(value).includes(text)
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

export function isExternalPtyProof(value: string) {
  return value.trim() === externalPtyMarker
}

export async function sameLocalPath(left: string, right: string) {
  const canonical = async (value: string) => {
    const absolute = resolve(value)
    return realpath(absolute).catch(() => absolute)
  }
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function releaseSmokeTerminalCommand() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$status = @(& git -C $env:MONGOLGPT_SMOKE_ROOT status --short)",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "$diff = @(& git -C $env:MONGOLGPT_SMOKE_ROOT diff)",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "[IO.File]::WriteAllLines($env:MONGOLGPT_SMOKE_PROOF, [string[]]($status + $diff), [Text.UTF8Encoding]::new($false))",
  ].join("; ")
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  }
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
async function postJsonValue(
  fetcher: FetchLike,
  base: URL,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  validate: (value: unknown) => boolean,
  timeoutMs: number,
) {
  const response = await fetcher(new URL(path, base), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  })
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
  const terminal = releaseSmokeTerminalCommand()
  const response = await fetcher(new URL("/pty", base), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      command: terminal.command,
      args: terminal.args,
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
async function disposeInstance(fetcher: FetchLike, base: URL, headers: Record<string, string>, timeoutMs: number) {
  await fetcher(new URL("/instance/dispose", base), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined)
}
async function removeSmokeDirectory(path: string) {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)
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
async function readExternalPtyProof(file: string): Promise<ReleaseSmokeCheck> {
  const value = await readFile(file, "utf8").catch(() => "")
  return isExternalPtyProof(value)
    ? { ok: true, detail: "packaged Electron PTY proof" }
    : { ok: false, detail: "external packaged PTY proof is invalid" }
}
async function defaultExec(command: string, args: string[], cwd: string) {
  return execFile(command, args, { cwd, windowsHide: true, encoding: "utf8" })
}
type LocalModelRequest = {
  path: string
  authorization: string
  body: Record<string, unknown>
}
async function startLocalModelServer() {
  let captured: LocalModelRequest | undefined
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString("utf8")
    const body = raw ? JSON.parse(raw) : {}
    captured = {
      path: url.pathname,
      authorization: request.headers.authorization ?? "",
      body: isRecord(body) ? body : {},
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not found" }))
      return
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const lines = [
      modelChunk({ role: "assistant" }),
      modelChunk({ content: localModelReply }),
      modelChunk({}, "stop", { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
    ]
    for (const line of lines) response.write(`data: ${JSON.stringify(line)}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("local model smoke server did not bind to a TCP port")
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    request: () => captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
function modelChunk(delta: Record<string, unknown>, finishReason?: string, usage?: Record<string, number>) {
  return {
    id: "chatcmpl-release-smoke",
    object: "chat.completion.chunk",
    created: 0,
    model: modelName,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(usage ? { usage } : {}),
  }
}
function hasLocalModelRequest(value: LocalModelRequest | undefined) {
  return (
    value?.path === "/v1/chat/completions" &&
    value.authorization === `Bearer ${localModelApiKey}` &&
    value.body.model === modelName &&
    JSON.stringify(value.body.messages).includes(localModelPrompt)
  )
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
