import { getSandbox } from "@cloudflare/sandbox"
import { matchesControlToken } from "@mongolgpt/runtime-auth/control"
import { startupDiagnosticEnv, startupDiagnosticPath } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { handleCheckpointOutbound } from "../../src/checkpoint-rpc"
import production, { ContainerProxy, MongolGPTSandbox } from "../../src/index"
import { createHistoryStore } from "../../src/history"
import { deriveRuntimeIdentity, RUNTIME_PROCESS_ID, runtimeReadiness } from "../../src/runtime"
import { fetchRuntime } from "../../src/runtime-http"
import { prepareRuntimeAccountCleanup } from "../../../console/function/src/runtime-account-cleanup"
import type { RuntimeAccountCleanup } from "../../src/account-cleanup-service"
import {
  emptyCanaryDiagnostics,
  parseCanaryStartupFailure,
  parseCanaryReadiness,
  sanitizeCanaryDiagnostics,
  summarizeCanaryLogs,
} from "../../script/canary-diagnostics"
import {
  canaryStartupConfigured,
  collectCanaryStartup,
  persistCanaryStartup,
  readCanaryStartup,
} from "./canary-startup"

export { ContainerProxy }
export { RuntimeAccountCleanup } from "../../src/index"

export const canaryScope = {
  accountID: "account_cloudflare_canary",
  workspaceID: "wrk_cloudflare_canary",
} as const

const canaryRunID = /^mgpt-canary-[0-9]{1,12}-[0-9]{1,3}$/
const canaryToken = /^[0-9a-f]{64}$/
const tokenHeader = "x-mongolgpt-canary-token"
const bootCountKey = "canary:bootCount"
const lastStopKey = "canary:lastStop"
const canaryBackupPrefix = "runtime-backups/v1/account_cloudflare_canary/wrk_cloudflare_canary/"
const purgeLimit = 4_000
const purgeBatchSize = 1_000

type Environment = Parameters<typeof production.fetch>[1] & {
  CANARY_RUN_ID: string
  CANARY_ADMIN_TOKEN: string
  RuntimeAccountCleanup?: Service<RuntimeAccountCleanup>
}
type IncomingRequest = Parameters<typeof production.fetch>[0]

type CanaryState = {
  bootCount: number
  lastStop: { exitCode?: number; reason?: string } | null
  state: SanitizedState
  epoch: number
  checkpointID?: string
  revisionID?: string
  revisionSequence?: number
}
type SanitizedState = { status?: string; lastChange?: number; exitCode?: number }
type StopParams = Parameters<MongolGPTSandbox["onStop"]>[0]

export class CanarySandbox extends MongolGPTSandbox {
  override startProcess(
    ...args: Parameters<MongolGPTSandbox["startProcess"]>
  ): ReturnType<MongolGPTSandbox["startProcess"]> {
    const [command, options] = args
    if (options?.processId !== RUNTIME_PROCESS_ID || !canaryStartupConfigured(this.env as Environment))
      return super.startProcess(...args)
    return super.startProcess(command, {
      ...options,
      env: { ...options.env, [startupDiagnosticEnv]: "true" },
    })
  }

  async recordStartupFailure(input: unknown) {
    if (!canaryStartupConfigured(this.env as Environment)) throw new Error("Invalid startup diagnostic")
    await persistCanaryStartup(this.ctx.storage, input)
  }

  async startupFailure() {
    return readCanaryStartup(this.ctx.storage)
  }

  override async onStart(): Promise<void> {
    await super.onStart()
    await this.ctx.storage.put(bootCountKey, (await this.bootCount()) + 1)
  }

  override async onStop(params?: StopParams): Promise<void> {
    await super.onStop(params)
    await this.ctx.storage.put(lastStopKey, safeStop(params))
  }

  async canaryState(): Promise<Pick<CanaryState, "bootCount" | "lastStop" | "state">> {
    const [bootCount, lastStop, state] = await Promise.all([this.bootCount(), this.lastStop(), this.getState()])
    return {
      bootCount,
      lastStop,
      state: sanitizeState(state),
    }
  }

  private async bootCount() {
    const value = await this.ctx.storage.get(bootCountKey)
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  private async lastStop() {
    const value = await this.ctx.storage.get(lastStopKey)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    return safeStop(value as StopParams)
  }
}

// Containers keys its handler registry by concrete class name, including canaries.
CanarySandbox.outboundHandlers = {
  ...MongolGPTSandbox.outboundHandlers,
  checkpoint: async (request, env, context) => {
    if (new URL(request.url).pathname !== startupDiagnosticPath) return handleCheckpointOutbound(request, env, context)
    return collectCanaryStartup(request, env, context, async (diagnostic) => {
      await (await canarySandbox(env as Environment)).recordStartupFailure(diagnostic)
    })
  },
}

export function canaryGate(request: Request, env: Partial<Environment>) {
  if (env.STAGE !== "dev") return false
  if (typeof env.CANARY_RUN_ID !== "string" || !canaryRunID.test(env.CANARY_RUN_ID)) return false
  if (typeof env.CANARY_ADMIN_TOKEN !== "string" || !canaryToken.test(env.CANARY_ADMIN_TOKEN)) return false
  return matchesControlToken(request.headers.get(tokenHeader), env.CANARY_ADMIN_TOKEN)
}

export default {
  async fetch(request: IncomingRequest, env: Environment) {
    if (!canaryGate(request, env)) return json({ error: "forbidden" }, 403)

    const url = new URL(request.url)
    if (url.pathname === "/__canary/state") return canaryState(request, env, url)
    if (url.pathname === "/__canary/diagnostics") return canaryDiagnostics(request, env, url)
    if (url.pathname === "/__canary/stop") return canaryStop(request, env, url)
    if (url.pathname === "/__canary/purge") return canaryPurge(request, env, url)
    if (url.pathname === "/__canary/account-cleanup") return canaryAccountCleanup(request, env, url)
    if (url.pathname === "/__canary/account-cleanup-state") return canaryAccountCleanupState(request, env, url)
    if (url.pathname === "/__canary" || url.pathname.startsWith("/__canary/")) return json({ error: "not_found" }, 404)

    return production.fetch(nativeRequest(request), env)
  },
} satisfies ExportedHandler<Environment>

async function canaryState(request: Request, env: Environment, url: URL) {
  if (request.method !== "GET") return methodNotAllowed(["GET"])
  if (url.search !== "") return json({ error: "invalid_request" }, 400)
  if (!(await strictEmptyBody(request))) return json({ error: "invalid_request" }, 400)
  const sandbox = await canarySandbox(env)
  if (env.MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP === "true" && env.HISTORY) {
    const retired = await env.HISTORY.prepare("SELECT account_id FROM runtime_history_retirement WHERE account_id = ?")
      .bind(canaryScope.accountID)
      .first()
    if (retired) return json({ ...(await sandbox.canaryState()), epoch: 0, retired: true })
  }
  const history = env.HISTORY ? createHistoryStore(env.HISTORY) : undefined
  const [state, receipts, epoch] = await Promise.all([
    sandbox.canaryState(),
    history ? historyReceipts(history) : {},
    history ? history.epoch(canaryScope) : 0,
  ])
  return json({ ...state, ...receipts, epoch })
}

async function canaryStop(request: Request, env: Environment, url: URL) {
  if (request.method !== "POST") return methodNotAllowed(["POST"])
  if (url.search !== "") return json({ error: "invalid_request" }, 400)
  if (!(await strictEmptyBody(request))) return json({ error: "invalid_request" }, 400)
  await (await canarySandbox(env)).stop("SIGTERM")
  return json({ accepted: true }, 202)
}

async function canaryAccountCleanup(request: Request, env: Environment, url: URL) {
  if (request.method !== "POST") return methodNotAllowed(["POST"])
  if (url.search !== "" || !(await strictEmptyBody(request))) return json({ error: "invalid_request" }, 400)
  try {
    const cleanup = await prepareRuntimeAccountCleanup(env.RuntimeAccountCleanup)
    return json(
      await cleanup({
        accountID: canaryScope.accountID,
        requestID: `del_${env.CANARY_RUN_ID}`,
        workspaceIDs: [canaryScope.workspaceID],
      }),
    )
  } catch {
    return json({ error: "cleanup_unavailable" }, 503)
  }
}

async function canaryAccountCleanupState(request: Request, env: Environment, url: URL) {
  if (request.method !== "GET") return methodNotAllowed(["GET"])
  if (url.search !== "" || !(await strictEmptyBody(request))) return json({ error: "invalid_request" }, 400)
  if (!env.HISTORY || !env.RUNTIME_BACKUPS) return json({ error: "unavailable" }, 503)
  const db = env.HISTORY
  const accountID = canaryScope.accountID
  const retired = await db
    .prepare("SELECT account_id FROM runtime_history_retirement WHERE account_id = ?")
    .bind(accountID)
    .first()
  const job = await db
    .prepare("SELECT phase, request_id FROM runtime_account_cleanup WHERE account_id = ?")
    .bind(accountID)
    .first<{ phase: number; request_id: string }>()
  let historyRows = 0
  for (const table of [
    "runtime_history_event",
    "runtime_history_session",
    "runtime_history_checkpoint_event",
    "runtime_file_revision",
    "runtime_history_checkpoint",
    "runtime_history_writer",
  ]) {
    const count = await db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`)
      .bind(accountID)
      .first<number>("n")
    if (!Number.isSafeInteger(count) || count === null || count < 0) return json({ error: "unavailable" }, 503)
    historyRows += count
  }
  const prefix = `runtime-backups/v1/${accountID}/`
  const options = { prefix, limit: 1000, include: ["customMetadata"] }
  const page = await env.RUNTIME_BACKUPS.list(options)
  if (page.truncated || page.objects.some((object) => !object.key.startsWith(prefix)))
    return json({ error: "unavailable" }, 503)
  const retainedFences = page.objects.filter(
    (object) =>
      object.size === 0 &&
      Object.keys(object.customMetadata ?? {}).length === 1 &&
      object.customMetadata?.["mongolgpt-retired-write"] === "v1",
  ).length
  const state = await (await canarySandbox(env)).canaryState()
  return json({
    retired: !!retired,
    complete: job?.phase === 5 && job.request_id === `del_${env.CANARY_RUN_ID}`,
    historyRows,
    backupContentObjects: page.objects.length - retainedFences,
    retainedFences,
    stopped: stopped(state.state),
    bootCount: state.bootCount,
  })
}

async function canaryDiagnostics(request: Request, env: Environment, url: URL) {
  if (request.method !== "GET") return methodNotAllowed(["GET"])
  if (url.search !== "") return json({ error: "invalid_request" }, 400)
  if (!(await strictEmptyBody(request))) return json({ error: "invalid_request" }, 400)

  const result = emptyCanaryDiagnostics()
  const timeout = Symbol("diagnostics timeout")
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(timeout)
    }, 8000)
  })
  const read = <T>(work: () => T | PromiseLike<T>) =>
    Promise.race([
      Promise.resolve().then(() => {
        if (expired) throw timeout
        return work()
      }),
      deadline,
    ])
  const failed = (error: unknown) => {
    if (error === timeout || expired) result.failure = "timeout"
    else result.failure ??= "unavailable"
  }
  try {
    const sandbox = await read(() => canarySandbox(env))
    await Promise.all([
      read(() => sandbox.startupFailure())
        .then((value) => {
          const safe = parseCanaryStartupFailure(value)
          if (safe === undefined) throw new Error("unavailable")
          result.startupFailure = safe
        })
        .catch(failed),
      (async () => {
        const state = await read(() => sandbox.canaryState())
        const safe = sanitizeCanaryDiagnostics({
          ...result,
          bootCount: state.bootCount,
          lastStop: state.lastStop
            ? {
                exitCode: state.lastStop.exitCode ?? null,
                reason:
                  state.lastStop.reason === "exit" || state.lastStop.reason === "runtime_signal"
                    ? state.lastStop.reason
                    : null,
              }
            : null,
          containerStatus: state.state.status ?? null,
        })
        if (!safe) throw new Error("unavailable")
        result.bootCount = safe.bootCount
        result.lastStop = safe.lastStop
        result.containerStatus = safe.containerStatus
        if (safe.containerStatus !== "running" && safe.containerStatus !== "healthy") return

        const process = await read(() => sandbox.getProcess(RUNTIME_PROCESS_ID))
        result.process.present = process !== null
        if (!process) return
        const safeProcess = sanitizeCanaryDiagnostics({
          ...result,
          process: { ...result.process, status: process.status, exitCode: process.exitCode ?? null },
        })
        if (!safeProcess) throw new Error("unavailable")
        result.process.status = safeProcess.process.status
        result.process.exitCode = safeProcess.process.exitCode
        if (process.status === "starting" || process.status === "running") {
          const identity = await read(() =>
            deriveRuntimeIdentity(canaryScope.accountID, canaryScope.workspaceID, env.MONGOLGPT_RUNTIME_SECRET),
          )
          const readiness = await read(() =>
            runtimeReadiness(
              {
                containerFetch: (request, port) => fetchRuntime(sandbox, request, port),
                probeReadiness: (password, restored, timeoutMs) =>
                  sandbox.probeReadiness(password, restored, timeoutMs),
              },
              identity.password,
              true,
            ),
          )
          const safeReadiness = parseCanaryReadiness(readiness)
          if (!safeReadiness) throw new Error("unavailable")
          result.readiness = safeReadiness
        }
        // Pinned SDK getLogs has no limit/abort option. Bound its duration and
        // inspect only a fixed prefix; never serialize the returned log strings.
        const logs = await read(() => process.getLogs())
        Object.assign(result.process, summarizeCanaryLogs(logs.stdout, logs.stderr))
      })().catch(failed),
      (async () => {
        if (!env.HISTORY) throw new Error("unavailable")
        const history = createHistoryStore(env.HISTORY)
        const [epoch, checkpoint, revision] = await read(() =>
          Promise.all([history.epoch(canaryScope), history.checkpoint(canaryScope), history.fileRevision(canaryScope)]),
        )
        result.epoch = epoch
        result.checkpointPresent = checkpoint !== undefined && checkpoint !== null
        result.revisionPresent = revision !== undefined && revision !== null
        result.sequence = revision?.data.sequence ?? null
      })().catch(failed),
    ])
  } catch (error) {
    failed(error)
  } finally {
    clearTimeout(timer)
  }
  return json(sanitizeCanaryDiagnostics(result) ?? { ...emptyCanaryDiagnostics(), failure: "unavailable" })
}

async function canaryPurge(request: Request, env: Environment, url: URL) {
  if (request.method !== "POST") return methodNotAllowed(["POST"])
  if (url.search !== "") return json({ error: "invalid_request" }, 400)
  if (!(await strictEmptyBody(request))) return json({ error: "invalid_request" }, 400)
  if (!env.RUNTIME_BACKUPS) return json({ error: "unavailable" }, 503)

  const sandbox = await canarySandbox(env)
  const state = await sandbox.getState()
  if (!stopped(state)) return json({ error: "sandbox_active" }, 409)

  const names = await listCanaryBackups(env.RUNTIME_BACKUPS)
  for (let index = 0; index < names.length; index += purgeBatchSize) {
    await env.RUNTIME_BACKUPS.delete(names.slice(index, index + purgeBatchSize))
  }
  return json({ purged: names.length })
}

async function canarySandbox(env: Environment) {
  const identity = await deriveRuntimeIdentity(
    canaryScope.accountID,
    canaryScope.workspaceID,
    env.MONGOLGPT_RUNTIME_SECRET,
  )
  return getSandbox(env.Sandbox, identity.sandboxID, {
    normalizeId: true,
    transport: "rpc",
    sleepAfter: "10m",
  }) as CanarySandbox
}

async function listCanaryBackups(bucket: Pick<R2Bucket, "list">) {
  const names: string[] = []
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < purgeLimit / purgeBatchSize; pageIndex++) {
    const page = await bucket.list({ prefix: canaryBackupPrefix, limit: purgeBatchSize, cursor })
    const pageNames = page.objects.map((object) => object.key)
    if (pageNames.some((name) => !name.startsWith(canaryBackupPrefix)))
      throw new Error("Canary R2 listing escaped prefix")
    if (names.length + pageNames.length > purgeLimit) throw new Error("Canary R2 purge cap exceeded")
    names.push(...pageNames)
    if (!page.truncated) return names
    if (pageNames.length === 0) throw new Error("Canary R2 purge truncated empty page")
    if (names.length >= purgeLimit) throw new Error("Canary R2 purge truncated beyond cap")
    if (!page.cursor || page.cursor === cursor) throw new Error("Canary R2 purge invalid cursor")
    cursor = page.cursor
  }
  throw new Error("Canary R2 purge truncated beyond cap")
}

async function historyReceipts(history: ReturnType<typeof createHistoryStore>) {
  const [checkpoint, revision] = await Promise.all([history.checkpoint(canaryScope), history.fileRevision(canaryScope)])
  return {
    checkpointID: checkpoint?.data.id,
    revisionID: revision?.data.id,
    revisionSequence: revision?.data.sequence,
  }
}

function stopped(state: unknown) {
  return (
    typeof state === "object" &&
    state !== null &&
    ((state as { status?: unknown }).status === "stopped" ||
      (state as { status?: unknown }).status === "stopped_with_code")
  )
}

function sanitizeState(state: unknown): SanitizedState {
  if (typeof state !== "object" || state === null) return {}
  const input = state as { status?: unknown; lastChange?: unknown; exitCode?: unknown }
  return {
    ...(typeof input.status === "string" ? { status: input.status } : {}),
    ...(typeof input.lastChange === "number" && Number.isSafeInteger(input.lastChange)
      ? { lastChange: input.lastChange }
      : {}),
    ...(typeof input.exitCode === "number" &&
    Number.isInteger(input.exitCode) &&
    input.exitCode >= 0 &&
    input.exitCode <= 255
      ? { exitCode: input.exitCode }
      : {}),
  }
}

function safeStop(params?: StopParams) {
  const stop: { exitCode?: number; reason?: string } = {}
  if (
    typeof params?.exitCode === "number" &&
    Number.isInteger(params.exitCode) &&
    params.exitCode >= 0 &&
    params.exitCode <= 255
  ) {
    stop.exitCode = params.exitCode
  }
  if (typeof params?.reason === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(params.reason)) stop.reason = params.reason
  return Object.keys(stop).length ? stop : null
}

function nativeRequest(request: IncomingRequest): IncomingRequest {
  const headers = new Headers(request.headers)
  headers.delete(tokenHeader)
  const clean = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
  })
  Object.defineProperty(clean, "cf", { value: request.cf })
  return clean as IncomingRequest
}

async function strictEmptyBody(request: Request) {
  const length = request.headers.get("content-length")
  if (length !== null && length !== "0") {
    void request.body?.cancel().catch(() => {})
    return false
  }
  if (!request.body) return true
  if (request.body.locked) return false

  const reader = request.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 1_000)
  })
  try {
    // Incoming Workers requests can expose an empty stream, including for GET.
    for (let reads = 0; reads < 4; reads++) {
      const chunk = await Promise.race([reader.read(), deadline])
      if (!chunk || chunk.value?.byteLength) return false
      if (chunk.done) return true
    }
    return false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function methodNotAllowed(methods: string[]) {
  return json({ error: "method_not_allowed" }, 405, { allow: methods.join(", ") })
}

function json(value: unknown, status = 200, input: HeadersInit = {}) {
  const headers = new Headers(input)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  return new Response(JSON.stringify(value), { status, headers })
}
