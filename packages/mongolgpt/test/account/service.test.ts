import { expect } from "bun:test"
import { Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import {
  AccessToken,
  AccountID,
  AccountTransportError,
  DeviceCode,
  Login,
  Org,
  OrgID,
  RefreshToken,
  UserCode,
} from "../../src/account/schema"
import { Database } from "@mongolgpt/core/database/database"
import { testEffect } from "../lib/effect"
import { configureAccountTokenEncryptionKey } from "../../src/account/token-codec"

configureAccountTokenEncryptionKey(new Uint8Array(32).fill(11))

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
).pipe(Layer.provide(Database.defaultLayer))

const it = testEffect(Layer.merge(AccountRepo.defaultLayer, truncate))

const insideEagerRefreshWindow = Duration.toMillis(Duration.minutes(1))
const outsideEagerRefreshWindow = Duration.toMillis(Duration.minutes(10))
const publicDns: Account.AccountDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }]

const live = (client: HttpClient.HttpClient) =>
  Account.layerWithDnsResolver(publicDns, { allowCustomAccountServer: true }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  )
const browserLive = Account.layerWithDnsResolver(publicDns, { allowCustomAccountServer: true }).pipe(
  Layer.provide(FetchHttpClient.layer),
)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const encodeOrg = Schema.encodeSync(Org)

const org = (id: string, name: string) => encodeOrg(new Org({ id: OrgID.make(id), name }))

const accountOverview = {
  account: {
    id: "acc_12345",
    email: "user@example.com",
    status: "active" as const,
    createdAt: 1_700_000_000_000,
  },
  currentWorkspaceID: "wrk_12345",
  workspaces: [
    {
      id: "wrk_12345",
      name: "Хувийн төсөл",
      slug: null,
      userID: "usr_12345",
      role: "admin" as const,
      subscription: null,
      limits: { plan: "free" as const, promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5 },
      quota: { status: "model-scoped" as const, reason: "free-auto-model-limits" as const },
      usage: {
        scope: "workspace" as const,
        period: "week" as const,
        periodStart: 1_700_000_000_000,
        periodEnd: 1_700_604_800_000,
        requestCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costInMicroCents: 0,
      },
    },
  ],
}

const login = () =>
  new Login({
    code: DeviceCode.make("device-code"),
    user: UserCode.make("user-code"),
    url: "https://one.example.com/verify",
    server: "https://one.example.com",
    expiry: Duration.seconds(600),
    interval: Duration.seconds(5),
  })

const deviceTokenClient = (body: unknown, status = 400) =>
  HttpClient.make((req) =>
    Effect.succeed(
      req.url === "https://one.example.com/auth/device/token" ? json(req, body, status) : json(req, {}, 404),
    ),
  )

const poll = (body: unknown, status = 400) =>
  Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(deviceTokenClient(body, status))))

it.live("browser login refuses token endpoint redirects", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
            })
          }
          if (url.pathname === "/token") return Response.redirect(`${url.origin}/redirected-token`, 302)
          if (url.pathname === "/redirected-token") {
            return Response.json({ access_token: "redirected", refresh_token: "redirected", expires_in: 60 })
          }
          if (url.pathname === "/api/user") return Response.json({ id: "redirected", email: "redirected@example.com" })
          if (url.pathname === "/api/orgs") return Response.json([])
          return new Response(null, { status: 404 })
        },
      }),
    ),
    (server) =>
      Effect.gen(function* () {
        const pending = yield* Account.use
          .browserLogin(`http://127.0.0.1:${server.port}`)
          .pipe(Effect.provide(browserLive))
        const authorization = new URL(pending.url)
        const redirect = authorization.searchParams.get("redirect_uri")
        const state = authorization.searchParams.get("state")
        expect(redirect).not.toBeNull()
        expect(state).not.toBeNull()

        const callback = new URL(redirect as string)
        callback.searchParams.set("code", "test-code")
        callback.searchParams.set("state", state as string)
        const response = yield* Effect.promise(() => fetch(callback))
        expect(response.status).toBe(200)

        const result = yield* Effect.exit(pending.wait)
        expect(Exit.isFailure(result)).toBe(true)
      }),
    (server) => Effect.sync(() => server.stop(true)),
  ),
)

it.live("browser login ignores a wrong-state error callback and accepts the matching callback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return Response.json({
              issuer: url.origin,
              authorization_endpoint: `${url.origin}/authorize`,
              token_endpoint: `${url.origin}/token`,
            })
          }
          if (url.pathname === "/token") {
            return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 })
          }
          if (url.pathname === "/api/user") return Response.json({ id: "user", email: "user@example.com" })
          if (url.pathname === "/api/orgs") return Response.json([])
          return new Response(null, { status: 404 })
        },
      }),
    ),
    (server) =>
      Effect.gen(function* () {
        const pending = yield* Account.use
          .browserLogin(`http://127.0.0.1:${server.port}`)
          .pipe(Effect.provide(browserLive))
        const authorization = new URL(pending.url)
        const redirect = authorization.searchParams.get("redirect_uri")
        const state = authorization.searchParams.get("state")
        expect(redirect).not.toBeNull()
        expect(state).not.toBeNull()

        const rejected = new URL(redirect as string)
        rejected.searchParams.set("error", "access_denied")
        rejected.searchParams.set("state", "wrong-state")
        const rejectedResponse = yield* Effect.promise(() => fetch(rejected))
        expect(rejectedResponse.status).toBe(400)

        const accepted = new URL(redirect as string)
        accepted.searchParams.set("code", "test-code")
        accepted.searchParams.set("state", state as string)
        const acceptedResponse = yield* Effect.promise(() => fetch(accepted))
        expect(acceptedResponse.status).toBe(200)

        const result = yield* pending.wait
        expect(result.email).toBe("user@example.com")
      }),
    (server) => Effect.sync(() => server.stop(true)),
  ),
)

it.live("login normalizes trailing slashes in the provided server URL", () =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        if (req.url === "https://one.example.com/auth/device/code") {
          return json(req, {
            device_code: "device-code",
            user_code: "user-code",
            verification_uri_complete: "/device?user_code=user-code",
            expires_in: 600,
            interval: 5,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use.login("https://one.example.com/").pipe(Effect.provide(live(client)))

    expect(seen).toEqual(["POST https://one.example.com/auth/device/code"])
    expect(result.server).toBe("https://one.example.com")
    expect(result.url).toBe("https://one.example.com/device?user_code=user-code")
  }),
)

it.live("login maps transport failures to account transport errors", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req }),
        }),
      ),
    )

    const error = yield* Effect.flip(Account.use.login("https://one.example.com").pipe(Effect.provide(live(client))))

    expect(error).toBeInstanceOf(AccountTransportError)
    if (error instanceof AccountTransportError) {
      expect(error.method).toBe("POST")
      expect(error.url).toBe("https://one.example.com/auth/device/code")
    }
  }),
)

it.live("orgsByAccount groups orgs per account", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-1"),
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-2"),
        email: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        if (req.url === "https://one.example.com/api/orgs") {
          return json(req, [org("org-1", "One")])
        }

        if (req.url === "https://two.example.com/api/orgs") {
          return json(req, [org("org-2", "Two A"), org("org-3", "Two B")])
        }

        return json(req, [], 404)
      }),
    )

    const rows = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))

    expect(rows.map((row) => [row.account.id, row.orgs.map((org) => org.id)]).map(([id, orgs]) => [id, orgs])).toEqual([
      [AccountID.make("user-1"), [OrgID.make("org-1")]],
      [AccountID.make("user-2"), [OrgID.make("org-2"), OrgID.make("org-3")]],
    ])
    expect(seen).toEqual(["GET https://one.example.com/api/orgs", "GET https://two.example.com/api/orgs"])
  }),
)

it.live("token refresh persists the new token", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.none(),
      }),
    )

    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/auth/device/token"
          ? json(req, {
              access_token: "at_new",
              refresh_token: "rt_new",
              expires_in: 60,
            })
          : json(req, {}, 404),
      ),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(token)).toBeDefined()
    expect(String(Option.getOrThrow(token))).toBe("at_new")

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
    expect(value.token_expiry).toBeGreaterThan(Date.now())
  }),
)

it.live("token refreshes before expiry when inside the eager refresh window", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() + insideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        if (req.url === "https://one.example.com/auth/device/token") {
          refreshCalls += 1
          return json(req, {
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 60,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(String(Option.getOrThrow(token))).toBe("at_new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("concurrent config and token requests coalesce token refresh", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.some(OrgID.make("org-9")),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        if (req.url === "https://one.example.com/auth/device/token") {
          refreshCalls += 1

          if (refreshCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            return json(req, {
              access_token: "at_new",
              refresh_token: "rt_new",
              expires_in: 60,
            })
          }

          return json(
            req,
            {
              error: "invalid_grant",
              error_description: "refresh token already used",
            },
            400,
          )
        }

        if (req.url === "https://one.example.com/api/config") {
          return json(req, { config: { theme: "light", seats: 5 } })
        }

        return json(req, {}, 404)
      }),
    )

    const [cfg, token] = yield* Account.Service.use((s) =>
      Effect.all([s.config(id, OrgID.make("org-9")), s.token(id)], { concurrency: 2 }),
    ).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(cfg)).toEqual({ theme: "light", seats: 5 })
    expect(String(Option.getOrThrow(token))).toBe("at_new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("config sends the selected org header", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: { auth?: string; org?: string } = {}
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.auth = req.headers.authorization
        seen.org = req.headers["x-org-id"]

        if (req.url === "https://one.example.com/api/config") {
          return json(req, { config: { theme: "light", seats: 5 } })
        }

        return json(req, {}, 404)
      }),
    )

    const cfg = yield* Account.Service.use((s) => s.config(id, OrgID.make("org-9"))).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(cfg)).toEqual({ theme: "light", seats: 5 })
    expect(seen).toEqual({
      auth: "Bearer at_1",
      org: "org-9",
    })
  }),
)

it.live("overview sends the refreshed bearer and selected workspace, then validates the public contract", () =>
  Effect.gen(function* () {
    const id = AccountID.make("acc_12345")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.some(OrgID.make("wrk_12345")),
      }),
    )

    const seen: Array<{ url: string; auth?: string; org?: string }> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push({ url: req.url, auth: req.headers.authorization, org: req.headers["x-org-id"] })
        if (req.url === "https://one.example.com/auth/device/token") {
          return json(req, { access_token: "at_new", refresh_token: "rt_new", expires_in: 600 })
        }
        if (req.url === "https://one.example.com/v1/account/overview") return json(req, accountOverview)
        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.Service.use((s) => s.overview(id, Option.some(OrgID.make("wrk_12345")))).pipe(
      Effect.provide(live(client)),
    )

    expect(result).toEqual(accountOverview)
    expect(seen).toEqual([
      { url: "https://one.example.com/auth/device/token", auth: undefined, org: undefined },
      { url: "https://one.example.com/v1/account/overview", auth: "Bearer at_new", org: "wrk_12345" },
    ])
  }),
)

it.live("overview rejects non-JSON and malformed success responses", () =>
  Effect.gen(function* () {
    const id = AccountID.make("acc_12345")
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const htmlClient = HttpClient.make((req) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response("<html>not an API</html>", { status: 200, headers: { "content-type": "text/html" } }),
        ),
      ),
    )
    const htmlError = yield* Effect.flip(
      Account.Service.use((s) => s.overview(id, Option.none())).pipe(Effect.provide(live(htmlClient))),
    )
    expect(htmlError).toBeInstanceOf(Error)
    expect(String(htmlError)).not.toContain("not an API")

    const malformedClient = HttpClient.make((req) => Effect.succeed(json(req, { ...accountOverview, secret: "no" })))
    const malformedError = yield* Effect.flip(
      Account.Service.use((s) => s.overview(id, Option.none())).pipe(Effect.provide(live(malformedClient))),
    )
    expect(malformedError).toBeInstanceOf(Error)
  }),
)

it.live("poll stores the account and first org on success", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/auth/device/token"
          ? json(req, {
              access_token: "at_1",
              refresh_token: "rt_1",
              token_type: "Bearer",
              expires_in: 60,
            })
          : req.url === "https://one.example.com/api/user"
            ? json(req, { id: "user-1", email: "user@example.com" })
            : req.url === "https://one.example.com/api/orgs"
              ? json(req, [org("org-1", "One")])
              : json(req, {}, 404),
      ),
    )

    const res = yield* Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(client)))

    expect(res._tag).toBe("PollSuccess")
    if (res._tag === "PollSuccess") {
      expect(String(res.id)).toBe("user-1")
      expect(res.email).toBe("user@example.com")
    }

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active)).toEqual(
      expect.objectContaining({
        id: "user-1",
        email: "user@example.com",
        active_org_id: "org-1",
      }),
    )
  }),
)

it.live("poll leaves organization selection empty when multiple orgs are available", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/auth/device/token"
          ? json(req, {
              access_token: "at_1",
              refresh_token: "rt_1",
              token_type: "Bearer",
              expires_in: 60,
            })
          : req.url === "https://one.example.com/api/user"
            ? json(req, { id: "user-1", email: "user@example.com" })
            : req.url === "https://one.example.com/api/orgs"
              ? json(req, [org("org-1", "One"), org("org-2", "Two")])
              : json(req, {}, 404),
      ),
    )

    const res = yield* Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(client)))

    expect(res._tag).toBe("PollSuccess")
    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBeNull()
  }),
)

for (const [name, body, expectedTag] of [
  [
    "pending",
    {
      error: "authorization_pending",
      error_description: "The authorization request is still pending",
    },
    "PollPending",
  ],
  [
    "slow",
    {
      error: "slow_down",
      error_description: "Polling too frequently, please slow down",
    },
    "PollSlow",
  ],
  [
    "denied",
    {
      error: "access_denied",
      error_description: "The authorization request was denied",
    },
    "PollDenied",
  ],
  [
    "expired",
    {
      error: "expired_token",
      error_description: "The device code has expired",
    },
    "PollExpired",
  ],
] as const) {
  it.live(`poll returns ${name} for ${body.error}`, () =>
    Effect.gen(function* () {
      const result = yield* poll(body)
      expect(result._tag).toBe(expectedTag)
    }),
  )
}

it.live("poll returns poll error for other OAuth errors", () =>
  Effect.gen(function* () {
    const result = yield* poll({
      error: "server_error",
      error_description: "An unexpected error occurred",
    })

    expect(result._tag).toBe("PollError")
    if (result._tag === "PollError") {
      expect(String(result.cause)).toContain("server_error")
    }
  }),
)
