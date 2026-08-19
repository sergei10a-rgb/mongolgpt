import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@mongolgpt/core/session/sql"
import { Database } from "@mongolgpt/core/database/database"
import { AccountV2 } from "@mongolgpt/core/account"
import { AccountStateTable, AccountTable } from "@mongolgpt/core/account/sql"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { configureAccountTokenEncryptionKey } from "../../src/account/token-codec"

configureAccountTokenEncryptionKey(new Uint8Array(32).fill(13))

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function oauthMetadataServer() {
  return Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname !== "/.well-known/oauth-authorization-server") return new Response(null, { status: 404 })
          return Response.json({
            issuer: url.origin,
            authorization_endpoint: `${url.origin}/authorize`,
            token_endpoint: `${url.origin}/token`,
          })
        },
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(AccountStateTable)
        .values({ id: 1, active_account_id: AccountV2.ID.make("account-test"), active_org_id: null })
        .onConflictDoUpdate({
          target: AccountStateTable.id,
          set: { active_account_id: AccountV2.ID.make("account-test"), active_org_id: null },
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "mongolgpt/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "returns and removes only the active account's public state",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* insertAccount()

        const account = yield* request(ExperimentalPaths.account, tmp.directory)
        expect(account.status).toBe(200)
        expect(yield* json(account)).toEqual({
          id: "account-test",
          email: "test@example.com",
          url: "https://console.example.com",
        })

        const removed = yield* request(ExperimentalPaths.account, tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toBe(true)

        const afterRemove = yield* request(ExperimentalPaths.account, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toBeNull()
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "starts and cancels a loopback browser login without exposing credentials",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const oauth = yield* oauthMetadataServer()
        const started = yield* request(ExperimentalPaths.accountLogin, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ server: oauth.url.toString() }),
        })

        expect(started.status).toBe(200)
        const body = yield* json<{ loginID: string; url: string }>(started)
        expect(body.loginID).toMatch(/^[0-9a-f-]{36}$/)
        expect(body.url).toContain("/authorize")

        const duplicate = yield* request(ExperimentalPaths.accountLogin, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ server: oauth.url.toString() }),
        })
        expect(duplicate.status).toBe(400)

        const pending = yield* request(`${ExperimentalPaths.accountLogin}/${body.loginID}`, tmp.directory)
        expect(pending.status).toBe(200)
        expect(yield* json(pending)).toEqual({ _tag: "pending" })

        const cancelled = yield* request(`${ExperimentalPaths.accountLogin}/${body.loginID}`, tmp.directory, {
          method: "DELETE",
        })
        expect(cancelled.status).toBe(200)
        expect(yield* json(cancelled)).toBe(true)

        const afterCancel = yield* request(`${ExperimentalPaths.accountLogin}/${body.loginID}`, tmp.directory)
        expect(afterCancel.status).toBe(404)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects insecure and unconfigured remote account servers",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(ExperimentalPaths.accountLogin, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ server: "http://accounts.example.com" }),
        })
        expect(response.status).toBe(400)

        const unconfigured = yield* request(ExperimentalPaths.accountLogin, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ server: "https://accounts.example.com" }),
        })
        expect(unconfigured.status).toBe(400)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps browser login running after the start request completes",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const oauth = yield* oauthMetadataServer()
        const started = yield* request(ExperimentalPaths.accountLogin, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ server: oauth.url.toString() }),
        })

        expect(started.status).toBe(200)
        const body = yield* json<{ loginID: string; url: string }>(started)
        const authorization = new URL(body.url)
        const redirect = authorization.searchParams.get("redirect_uri")
        const state = authorization.searchParams.get("state")
        expect(redirect).toStartWith("http://127.0.0.1:")
        expect(state).not.toBeNull()

        const denied = new URL(redirect!)
        denied.searchParams.set("error", "access_denied")
        denied.searchParams.set("state", state!)
        const callback = yield* Effect.tryPromise(() => fetch(denied))
        expect(callback.status).toBe(400)

        const terminal = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 50; attempt++) {
            const response = yield* request(`${ExperimentalPaths.accountLogin}/${body.loginID}`, tmp.directory)
            expect(response.status).toBe(200)
            const status = yield* json<{ _tag: "pending" } | { _tag: "error"; message: string }>(response)
            if (status._tag !== "pending") return status
            yield* Effect.sleep("20 millis")
          }
          return yield* Effect.fail(new Error("browser login did not reach a terminal state"))
        })

        expect(terminal).toEqual({ _tag: "error", message: "Нэвтрэх үйлдэл амжилтгүй боллоо" })
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not expose unknown browser login records",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const status = yield* request(`${ExperimentalPaths.accountLogin}/missing`, tmp.directory)
        expect(status.status).toBe(404)
        const cancelled = yield* request(`${ExperimentalPaths.accountLogin}/missing`, tmp.directory, {
          method: "DELETE",
        })
        expect(cancelled.status).toBe(404)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=mongolgpt&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktree-ийг зөвхөн Git төсөлд ашиглана" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
