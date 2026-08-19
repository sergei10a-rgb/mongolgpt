import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Fiber, Option, Semaphore } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConsoleSwitchPayload, SessionListQuery, ToolListQuery, WorktreeApiError } from "../groups/experimental"

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const LOGIN_RESULT_TTL_MS = 5 * 60 * 1000
const LOGIN_ERROR_MESSAGE = "Нэвтрэх үйлдэл амжилтгүй боллоо"
const LOGIN_TIMEOUT_MESSAGE = "Нэвтрэх хугацаа дууссан"

type LoginStatus = { _tag: "pending" } | { _tag: "success"; email: string } | { _tag: "error"; message: string }

type LoginRecord = {
  status: LoginStatus
  expiresAt: number
  fiber?: Fiber.Fiber<void>
  timer: ReturnType<typeof setTimeout>
}

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const logins = new Map<string, LoginRecord>()
    const loginGate = yield* Semaphore.make(1)

    const clearLogin = (loginID: string) => {
      const record = logins.get(loginID)
      if (!record) return undefined
      clearTimeout(record.timer)
      logins.delete(loginID)
      return record
    }

    const expireLogin = (loginID: string) => {
      const record = clearLogin(loginID)
      record?.fiber?.interruptUnsafe()
    }

    const scheduleLoginExpiry = (loginID: string, delay: number) => setTimeout(() => expireLogin(loginID), delay)

    const pruneLogins = Effect.fn("ExperimentalHttpApi.account.pruneLogins")(function* () {
      const now = Date.now()
      for (const [loginID, record] of logins) {
        if (record.expiresAt > now) continue
        const expired = clearLogin(loginID)
        if (expired?.fiber) yield* Fiber.interrupt(expired.fiber)
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...logins.keys()], (loginID) => {
        const record = clearLogin(loginID)
        return record?.fiber ? Fiber.interrupt(record.fiber) : Effect.void
      }),
    )

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getAccount = Effect.fn("ExperimentalHttpApi.account")(function* () {
      const active = yield* account.active().pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      if (Option.isNone(active)) return null
      return {
        id: active.value.id,
        email: active.value.email,
        url: active.value.url,
        ...(active.value.active_org_id ? { activeOrgID: active.value.active_org_id } : {}),
      }
    })

    const removeAccount = Effect.fn("ExperimentalHttpApi.accountRemove")(function* () {
      const active = yield* account.active().pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      if (Option.isSome(active))
        yield* account.remove(active.value.id).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return true
    })

    const startAccountLogin = Effect.fn("ExperimentalHttpApi.accountLogin")((ctx: { payload: { server: string } }) =>
      loginGate.withPermits(1)(
        Effect.gen(function* () {
          yield* pruneLogins()
          if ([...logins.values()].some((record) => record.status._tag === "pending")) {
            return yield* Effect.fail(new HttpApiError.BadRequest({}))
          }
          const browser = yield* account
            .browserLogin(ctx.payload.server)
            .pipe(Effect.catchCause(() => Effect.fail(new HttpApiError.BadRequest({}))))
          const loginID = crypto.randomUUID()
          const timer = scheduleLoginExpiry(loginID, LOGIN_TIMEOUT_MS)
          logins.set(loginID, { status: { _tag: "pending" }, expiresAt: Date.now() + LOGIN_TIMEOUT_MS, timer })

          const wait = browser.wait.pipe(
            Effect.flatMap((result) => config.invalidate().pipe(Effect.as(result))),
            Effect.map((result) => ({ _tag: "success", email: result.email }) as const),
            Effect.timeout(LOGIN_TIMEOUT_MS),
            Effect.catchTag("TimeoutError", () =>
              Effect.succeed({ _tag: "error", message: LOGIN_TIMEOUT_MESSAGE } as const),
            ),
            Effect.catch(() => Effect.succeed({ _tag: "error", message: LOGIN_ERROR_MESSAGE } as const)),
            Effect.catchCause(() => Effect.succeed({ _tag: "error", message: LOGIN_ERROR_MESSAGE } as const)),
            Effect.tap((status) =>
              Effect.sync(() => {
                const current = logins.get(loginID)
                if (!current || current.status._tag !== "pending") return
                clearTimeout(current.timer)
                logins.set(loginID, {
                  status,
                  expiresAt: Date.now() + LOGIN_RESULT_TTL_MS,
                  timer: scheduleLoginExpiry(loginID, LOGIN_RESULT_TTL_MS),
                })
              }),
            ),
            Effect.asVoid,
          )
          const fiber = yield* Effect.forkDetach(wait)
          const record = logins.get(loginID)
          if (record) record.fiber = fiber
          return { loginID, url: browser.url }
        }),
      ),
    )

    const getAccountLogin = Effect.fn("ExperimentalHttpApi.accountLoginStatus")(function* (ctx: {
      params: { loginID: string }
    }) {
      yield* pruneLogins()
      const record = logins.get(ctx.params.loginID)
      if (!record) return yield* Effect.fail(new HttpApiError.NotFound({}))
      return record.status
    })

    const cancelAccountLogin = Effect.fn("ExperimentalHttpApi.accountLoginCancel")(function* (ctx: {
      params: { loginID: string }
    }) {
      yield* pruneLogins()
      const record = clearLogin(ctx.params.loginID)
      if (!record) return yield* Effect.fail(new HttpApiError.NotFound({}))
      if (record.fiber) yield* Fiber.interrupt(record.fiber)
      return true
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const all = yield* sessions.listGlobal({
        directory: ctx.query.directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("account", getAccount)
      .handle("accountRemove", removeAccount)
      .handle("accountLogin", startAccountLogin)
      .handle("accountLoginStatus", getAccountLogin)
      .handle("accountLoginCancel", cancelAccountLogin)
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
  }),
)
