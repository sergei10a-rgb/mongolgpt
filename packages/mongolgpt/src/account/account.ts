import { LayerNode } from "@mongolgpt/core/effect/layer-node"
import { httpClient } from "@mongolgpt/core/effect/layer-node-platform"
import { Cache, Clock, Duration, Effect, Layer, Option, Schema, SchemaGetter, Context } from "effect"
import { serviceUse } from "@mongolgpt/core/effect/service-use"
import { createServer, type Server } from "node:http"
import { createClient } from "@openauthjs/openauth/client"
import { OauthCallbackPage } from "@mongolgpt/core/oauth/page"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

import { withTransientReadRetry } from "@/util/effect-http-client"
import { AccountRepo, type AccountRow } from "./repo"
import { normalizeServerUrl, resolveAuthServerUrl } from "./url"
import {
  type AccountError,
  AccessToken,
  AccountID,
  DeviceCode,
  Info,
  RefreshToken,
  AccountServiceError,
  AccountTransportError,
  Login,
  Org,
  OrgID,
  PollDenied,
  PollError,
  PollExpired,
  PollPending,
  type PollResult,
  PollSlow,
  PollSuccess,
  UserCode,
} from "./schema"

export {
  AccountID,
  type AccountError,
  AccountRepoError,
  AccountServiceError,
  AccountTransportError,
  AccessToken,
  RefreshToken,
  DeviceCode,
  UserCode,
  Info,
  Org,
  OrgID,
  Login,
  PollSuccess,
  PollPending,
  PollSlow,
  PollExpired,
  PollDenied,
  PollError,
  PollResult,
} from "./schema"

export type AccountOrgs = {
  account: Info
  orgs: readonly Org[]
}

export type ActiveOrg = {
  account: Info
  org: Org
}

export type BrowserLogin = {
  url: string
  wait: Effect.Effect<PollSuccess, AccountError>
}

class RemoteConfig extends Schema.Class<RemoteConfig>("RemoteConfig")({
  config: Schema.Record(Schema.String, Schema.Json),
}) {}

class OpenAuthWellKnown extends Schema.Class<OpenAuthWellKnown>("OpenAuthWellKnown")({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
}) {}

const DurationFromSeconds = Schema.Number.pipe(
  Schema.decodeTo(Schema.Duration, {
    decode: SchemaGetter.transform((n) => Duration.seconds(n)),
    encode: SchemaGetter.transform((d) => Duration.toSeconds(d)),
  }),
)

class TokenRefresh extends Schema.Class<TokenRefresh>("TokenRefresh")({
  access_token: AccessToken,
  refresh_token: RefreshToken,
  expires_in: DurationFromSeconds,
}) {}

class DeviceAuth extends Schema.Class<DeviceAuth>("DeviceAuth")({
  device_code: DeviceCode,
  user_code: UserCode,
  verification_uri_complete: Schema.String,
  expires_in: DurationFromSeconds,
  interval: DurationFromSeconds,
}) {}

class DeviceTokenSuccess extends Schema.Class<DeviceTokenSuccess>("DeviceTokenSuccess")({
  access_token: AccessToken,
  refresh_token: RefreshToken,
  token_type: Schema.Literal("Bearer"),
  expires_in: DurationFromSeconds,
}) {}

class DeviceTokenError extends Schema.Class<DeviceTokenError>("DeviceTokenError")({
  error: Schema.String,
  error_description: Schema.String,
}) {
  toPollResult(): PollResult {
    if (this.error === "authorization_pending") return new PollPending()
    if (this.error === "slow_down") return new PollSlow()
    if (this.error === "expired_token") return new PollExpired()
    if (this.error === "access_denied") return new PollDenied()
    return new PollError({ cause: this.error })
  }
}

const DeviceToken = Schema.Union([DeviceTokenSuccess, DeviceTokenError])

class User extends Schema.Class<User>("User")({
  id: AccountID,
  email: Schema.String,
}) {}

class ClientId extends Schema.Class<ClientId>("ClientId")({ client_id: Schema.String }) {}

class DeviceTokenRequest extends Schema.Class<DeviceTokenRequest>("DeviceTokenRequest")({
  grant_type: Schema.String,
  device_code: DeviceCode,
  client_id: Schema.String,
}) {}

class TokenRefreshRequest extends Schema.Class<TokenRefreshRequest>("TokenRefreshRequest")({
  grant_type: Schema.String,
  refresh_token: RefreshToken,
  client_id: Schema.String,
}) {}

const clientId = "mongolgpt-cli"
const eagerRefreshThreshold = Duration.minutes(5)
const eagerRefreshThresholdMs = Duration.toMillis(eagerRefreshThreshold)

const isTokenFresh = (tokenExpiry: number | null, now: number) =>
  tokenExpiry != null && tokenExpiry > now + eagerRefreshThresholdMs

const initialOrg = (orgs: readonly Org[]) =>
  orgs.length === 1 ? Option.some(orgs[0].id) : Option.none<OrgID>()

const mapAccountServiceError =
  (message = "Account үйлчилгээний үйлдэл амжилтгүй боллоо") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountError, R> =>
    effect.pipe(Effect.mapError((cause) => accountErrorFromCause(cause, message)))

const accountErrorFromCause = (cause: unknown, message: string): AccountError => {
  if (cause instanceof AccountServiceError || cause instanceof AccountTransportError) {
    return cause
  }

  if (HttpClientError.isHttpClientError(cause)) {
    switch (cause.reason._tag) {
      case "TransportError": {
        return AccountTransportError.fromHttpClientError(cause.reason)
      }
      default: {
        return new AccountServiceError({ message, cause })
      }
    }
  }

  return new AccountServiceError({ message, cause })
}

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountError>
  readonly activeOrg: () => Effect.Effect<Option.Option<ActiveOrg>, AccountError>
  readonly list: () => Effect.Effect<Info[], AccountError>
  readonly orgsByAccount: () => Effect.Effect<readonly AccountOrgs[], AccountError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountError>
  readonly orgs: (accountID: AccountID) => Effect.Effect<readonly Org[], AccountError>
  readonly config: (
    accountID: AccountID,
    orgID: OrgID,
  ) => Effect.Effect<Option.Option<Record<string, unknown>>, AccountError>
  readonly token: (accountID: AccountID) => Effect.Effect<Option.Option<AccessToken>, AccountError>
  readonly browserLogin: (url: string) => Effect.Effect<BrowserLogin, AccountError>
  readonly login: (url: string) => Effect.Effect<Login, AccountError>
  readonly poll: (input: Login) => Effect.Effect<PollResult, AccountError>
}

export class Service extends Context.Service<Service, Interface>()("@mongolgpt/Account") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, AccountRepo.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service
    const http = yield* HttpClient.HttpClient
    const httpRead = withTransientReadRetry(http)
    const httpOk = HttpClient.filterStatusOk(http)
    const httpReadOk = HttpClient.filterStatusOk(httpRead)

    const executeRead = (request: HttpClientRequest.HttpClientRequest) =>
      httpRead.execute(request).pipe(mapAccountServiceError("HTTP хүсэлт амжилтгүй боллоо"))

    const executeReadOk = (request: HttpClientRequest.HttpClientRequest) =>
      httpReadOk.execute(request).pipe(mapAccountServiceError("HTTP хүсэлт амжилтгүй боллоо"))

    const executeEffectOk = <E>(request: Effect.Effect<HttpClientRequest.HttpClientRequest, E>) =>
      request.pipe(
        Effect.flatMap((req) => httpOk.execute(req)),
        mapAccountServiceError("HTTP хүсэлт амжилтгүй боллоо"),
      )

    const executeEffect = <E>(request: Effect.Effect<HttpClientRequest.HttpClientRequest, E>) =>
      request.pipe(
        Effect.flatMap((req) => http.execute(req)),
        mapAccountServiceError("HTTP хүсэлт амжилтгүй боллоо"),
      )

    const refreshToken = Effect.fnUntraced(function* (row: AccountRow) {
      const now = yield* Clock.currentTimeMillis

      const response = yield* executeEffectOk(
        HttpClientRequest.post(`${row.url}/auth/device/token`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.schemaBodyJson(TokenRefreshRequest)(
            new TokenRefreshRequest({
              grant_type: "refresh_token",
              refresh_token: row.refresh_token,
              client_id: clientId,
            }),
          ),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(TokenRefresh)(response).pipe(
        mapAccountServiceError("Хариуг уншиж чадсангүй"),
      )

      const expiry = Option.some(now + Duration.toMillis(parsed.expires_in))

      yield* repo.persistToken({
        accountID: row.id,
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token,
        expiry,
      })

      return parsed.access_token
    })

    const refreshTokenCache = yield* Cache.make<AccountID, AccessToken, AccountError>({
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: Duration.zero,
      lookup: Effect.fnUntraced(function* (accountID) {
        const maybeAccount = yield* repo.getRow(accountID)
        if (Option.isNone(maybeAccount)) {
          return yield* Effect.fail(new AccountServiceError({ message: "Token шинэчлэх үед account олдсонгүй" }))
        }

        const account = maybeAccount.value
        const now = yield* Clock.currentTimeMillis
        if (isTokenFresh(account.token_expiry, now)) {
          return account.access_token
        }

        return yield* refreshToken(account)
      }),
    })

    const resolveToken = Effect.fnUntraced(function* (row: AccountRow) {
      const now = yield* Clock.currentTimeMillis
      if (isTokenFresh(row.token_expiry, now)) {
        return row.access_token
      }

      return yield* Cache.get(refreshTokenCache, row.id)
    })

    const resolveAccess = Effect.fnUntraced(function* (accountID: AccountID) {
      const maybeAccount = yield* repo.getRow(accountID)
      if (Option.isNone(maybeAccount)) return Option.none()

      const account = maybeAccount.value
      const accessToken = yield* resolveToken(account)
      return Option.some({ account, accessToken })
    })

    const fetchOrgs = Effect.fnUntraced(function* (url: string, accessToken: AccessToken) {
      const response = yield* executeReadOk(
        HttpClientRequest.get(`${url}/api/orgs`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
        ),
      )

      return yield* HttpClientResponse.schemaBodyJson(Schema.Array(Org))(response).pipe(
        mapAccountServiceError("Хариуг уншиж чадсангүй"),
      )
    })

    const fetchUser = Effect.fnUntraced(function* (url: string, accessToken: AccessToken) {
      const response = yield* executeReadOk(
        HttpClientRequest.get(`${url}/api/user`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
        ),
      )

      return yield* HttpClientResponse.schemaBodyJson(User)(response).pipe(
        mapAccountServiceError("Хариуг уншиж чадсангүй"),
      )
    })

    const browserLogin = Effect.fn("Account.browserLogin")(function* (server: string) {
      const normalizedServer = normalizeServerUrl(server)
      const authServer = resolveAuthServerUrl(server)

      const metadataResponse = yield* executeReadOk(
        HttpClientRequest.get(`${authServer}/.well-known/oauth-authorization-server`).pipe(
          HttpClientRequest.acceptJson,
        ),
      )
      yield* HttpClientResponse.schemaBodyJson(OpenAuthWellKnown)(metadataResponse).pipe(
        mapAccountServiceError("OpenAuth metadata уншиж чадсангүй"),
      )

      const callback = yield* Effect.tryPromise({
        try: () => createBrowserCallbackServer(),
        catch: (cause) => cause,
      }).pipe(mapAccountServiceError("Browser OAuth callback server эхлүүлж чадсангүй"))

      const client = createClient({ clientID: clientId, issuer: authServer })
      const authorization = yield* Effect.tryPromise({
        try: () => client.authorize(callback.redirect, "code", { pkce: true }),
        catch: (cause) => cause,
      }).pipe(mapAccountServiceError("Browser OAuth зөвшөөрлийн URL үүсгэж чадсангүй"))
      callback.setState(authorization.challenge.state)

      const wait = Effect.gen(function* () {
        const code = yield* Effect.tryPromise({
          try: () => callback.code,
          catch: (cause) => cause,
        }).pipe(mapAccountServiceError("Browser OAuth callback амжилтгүй боллоо"))

        const exchanged = yield* Effect.tryPromise({
          try: () => client.exchange(code, callback.redirect, authorization.challenge.verifier),
          catch: (cause) => cause,
        }).pipe(mapAccountServiceError("Browser OAuth token солилцоо амжилтгүй боллоо"))

        if (exchanged.err) {
          return yield* Effect.fail(
            new AccountServiceError({ message: "Browser OAuth token солилцоо амжилтгүй боллоо", cause: exchanged.err }),
          )
        }

        const accessToken = AccessToken.make(exchanged.tokens.access)
        const refreshToken = RefreshToken.make(exchanged.tokens.refresh)
        const [account, remoteOrgs] = yield* Effect.all(
          [fetchUser(normalizedServer, accessToken), fetchOrgs(normalizedServer, accessToken)],
          { concurrency: 2 },
        )

        const expiry = (yield* Clock.currentTimeMillis) + exchanged.tokens.expiresIn * 1000

        yield* repo.persistAccount({
          id: account.id,
          email: account.email,
          url: normalizedServer,
          accessToken,
          refreshToken,
          expiry,
          orgID: initialOrg(remoteOrgs),
        })

        return new PollSuccess({ email: account.email })
      }).pipe(Effect.ensuring(Effect.promise(() => callback.close())))

      return { url: authorization.url, wait }
    })

    const token = Effect.fn("Account.token")((accountID: AccountID) =>
      resolveAccess(accountID).pipe(Effect.map(Option.map((r) => r.accessToken))),
    )

    const activeOrg = Effect.fn("Account.activeOrg")(function* () {
      const activeAccount = yield* repo.active()
      if (Option.isNone(activeAccount)) return Option.none<ActiveOrg>()

      const account = activeAccount.value
      if (!account.active_org_id) return Option.none<ActiveOrg>()

      const accountOrgs = yield* orgs(account.id)
      const org = accountOrgs.find((item) => item.id === account.active_org_id)
      if (!org) return Option.none<ActiveOrg>()

      return Option.some({ account, org })
    })

    const orgsByAccount = Effect.fn("Account.orgsByAccount")(function* () {
      const accounts = yield* repo.list()
      return yield* Effect.forEach(
        accounts,
        (account) =>
          orgs(account.id).pipe(
            Effect.catch(() => Effect.succeed([] as readonly Org[])),
            Effect.map((orgs) => ({ account, orgs })),
          ),
        { concurrency: 3 },
      )
    })

    const orgs = Effect.fn("Account.orgs")(function* (accountID: AccountID) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return []

      const { account, accessToken } = resolved.value

      return yield* fetchOrgs(account.url, accessToken)
    })

    const config = Effect.fn("Account.config")(function* (accountID: AccountID, orgID: OrgID) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return Option.none()

      const { account, accessToken } = resolved.value

      const response = yield* executeRead(
        HttpClientRequest.get(`${account.url}/api/config`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
          HttpClientRequest.setHeaders({ "x-org-id": orgID }),
        ),
      )

      if (response.status === 404) return Option.none()

      const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(mapAccountServiceError())

      const parsed = yield* HttpClientResponse.schemaBodyJson(RemoteConfig)(ok).pipe(
        mapAccountServiceError("Хариуг уншиж чадсангүй"),
      )
      return Option.some(parsed.config)
    })

    const login = Effect.fn("Account.login")(function* (server: string) {
      const normalizedServer = normalizeServerUrl(server)
      const response = yield* executeEffectOk(
        HttpClientRequest.post(`${normalizedServer}/auth/device/code`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.schemaBodyJson(ClientId)(new ClientId({ client_id: clientId })),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceAuth)(response).pipe(
        mapAccountServiceError("Хариуг уншиж чадсангүй"),
      )
      return new Login({
        code: parsed.device_code,
        user: parsed.user_code,
        url: `${normalizedServer}${parsed.verification_uri_complete}`,
        server: normalizedServer,
        expiry: parsed.expires_in,
        interval: parsed.interval,
      })
    })

    const poll = Effect.fn("Account.poll")(function* (input: Login) {
      const response = yield* executeEffect(
        HttpClientRequest.post(`${input.server}/auth/device/token`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.schemaBodyJson(DeviceTokenRequest)(
            new DeviceTokenRequest({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: input.code,
              client_id: clientId,
            }),
          ),
        ),
      )

      const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceToken)(response).pipe(
        mapAccountServiceError("Хариуг уншиж чадсангүй"),
      )

      if (parsed instanceof DeviceTokenError) return parsed.toPollResult()
      const accessToken = parsed.access_token

      const user = fetchUser(input.server, accessToken)
      const orgs = fetchOrgs(input.server, accessToken)

      const [account, remoteOrgs] = yield* Effect.all([user, orgs], { concurrency: 2 })

      const now = yield* Clock.currentTimeMillis
      const expiry = now + Duration.toMillis(parsed.expires_in)
      const refreshToken = parsed.refresh_token

      yield* repo.persistAccount({
        id: account.id,
        email: account.email,
        url: input.server,
        accessToken,
        refreshToken,
        expiry,
        orgID: initialOrg(remoteOrgs),
      })

      return new PollSuccess({ email: account.email })
    })

    return Service.of({
      active: repo.active,
      activeOrg,
      list: repo.list,
      orgsByAccount,
      remove: repo.remove,
      use: repo.use,
      orgs,
      config,
      token,
      browserLogin,
      login,
      poll,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AccountRepo.defaultLayer), Layer.provide(FetchHttpClient.layer))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AccountRepo.node, httpClient] })

export * as Account from "./account"

type BrowserCallbackServer = {
  redirect: string
  code: Promise<string>
  setState: (state: string) => void
  close: () => Promise<void>
}

const browserCallbackHost = "127.0.0.1"
const browserCallbackPath = "/auth/callback"

function createBrowserCallbackServer(): Promise<BrowserCallbackServer> {
  return new Promise((resolve, reject) => {
    let expectedState = ""
    let settled = false
    let resolveCode: (code: string) => void = () => {}
    let rejectCode: (error: Error) => void = () => {}

    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const server: Server = createServer((request, response) => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      const url = new URL(request.url ?? "/", `http://${browserCallbackHost}:${port}`)

      if (url.pathname !== browserCallbackPath) {
        response.writeHead(404).end("Not found")
        return
      }

      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      const value = url.searchParams.get("code")
      const state = url.searchParams.get("state")

      if (error) {
        settle(() => rejectCode(new Error(error)))
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(OauthCallbackPage.error(error, { provider: "MongolGPT" }))
        return
      }

      if (!value || state !== expectedState) {
        const message = value ? "OAuth state буруу байна" : "Authorization code алга"
        settle(() => rejectCode(new Error(message)))
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(OauthCallbackPage.error(message, { provider: "MongolGPT" }))
        return
      }

      settle(() => resolveCode(value))
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(OauthCallbackPage.success({ provider: "MongolGPT" }))
    })

    server.once("error", reject)
    server.listen(0, browserCallbackHost, () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Could not determine OAuth callback port"))
        return
      }

      resolve({
        redirect: `http://${browserCallbackHost}:${address.port}${browserCallbackPath}`,
        code,
        setState: (state) => {
          expectedState = state
        },
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose())
          }),
      })
    })
  })
}
