import { createServer } from "node:http"
import { Deferred, Effect, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import type { IntegrationOAuthMethodRegistration } from "@mongolgpt/plugin/v2/effect/integration"
import { define } from "@mongolgpt/plugin/v2/effect/plugin"
import type { CredentialValue } from "@mongolgpt/sdk/v2/types"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EventV2 } from "../../event"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { OauthCallbackPage } from "../../oauth/page"
import { ProviderV2 } from "../../provider"
import { ConfigProviderV1 } from "../../v1/config/provider"
import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { ConfigV1 } from "../../v1/config/config"
import { env } from "../../flag/flag"
import { productServiceUrls } from "../../product"

const defaultServer = env("MONGOLGPT_CONSOLE_URL")?.trim() || productServiceUrls.console
const defaultAuthServer = env("MONGOLGPT_AUTH_URL")?.trim() || productServiceUrls.auth
const clientID = "mongolgpt-cli"
const callbackPort = 1456
const methodID = Integration.MethodID.make("device")
const RemoteResponse = Schema.Struct({ config: ConfigV1.Info })
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
})
const User = Schema.Struct({ id: Schema.String, email: Schema.String })
const Org = Schema.Struct({ id: Schema.String, name: Schema.String })

function oauth(http: HttpClient.HttpClient) {
  return {
    integrationID: Integration.ID.make("mongolgpt"),
    method: {
      id: methodID,
      type: "oauth",
      label: "MongolGPT Console account",
    },
    authorize: () =>
      Effect.gen(function* () {
        const pkce = yield* Effect.promise(generatePKCE)
        const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
        const code = yield* Deferred.make<string, Error>()
        const redirect = `http://localhost:${callbackPort}/auth/callback`
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", `http://localhost:${callbackPort}`)
          if (url.pathname !== "/auth/callback") {
            response.writeHead(404).end("Not found")
            return
          }

          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          const value = url.searchParams.get("code")
          if (error) {
            Effect.runFork(Deferred.fail(code, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
              .end(OauthCallbackPage.error(error, { provider: "MongolGPT" }))
            return
          }
          if (!value || url.searchParams.get("state") !== state) {
            const message = value ? "OAuth state буруу байна" : "Authorization code алга"
            Effect.runFork(Deferred.fail(code, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
              .end(OauthCallbackPage.error(message, { provider: "MongolGPT" }))
            return
          }

          Effect.runFork(Deferred.succeed(code, value))
          response
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(OauthCallbackPage.success({ provider: "MongolGPT" }))
        })
        yield* Effect.callback<void, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)))
          server.listen(callbackPort, "localhost", () => resume(Effect.void))
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        return {
          mode: "auto" as const,
          url: authorizeURL(defaultAuthServer, redirect, pkce, state),
          instructions: "Browser дээрээ зөвшөөрлөө баталгаажуулна уу. Энэ цонх автоматаар хаагдана.",
          callback: Deferred.await(code).pipe(
            Effect.flatMap((value) => exchange(defaultAuthServer, value, redirect, pkce)),
            Effect.flatMap((token) => credential(http, defaultServer, token)),
          ),
        }
      }),
    refresh: (credential) =>
      Effect.gen(function* () {
        const server = typeof credential.metadata?.server === "string" ? credential.metadata.server : defaultServer
        const token = yield* post(
          http,
          `${server}/auth/device/token`,
          { grant_type: "refresh_token", refresh_token: credential.refresh, client_id: clientID },
          Token,
        )
        return {
          ...credential,
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000,
        }
      }),
    label: (credential) => {
      return typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : undefined
    },
  } satisfies IntegrationOAuthMethodRegistration
}

export const MongolGPTPlugin = define<HttpClient.HttpClient | EventV2.Service | Scope.Scope>({
  id: "mongolgpt",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const http = yield* HttpClient.HttpClient
    const loading = Semaphore.makeUnsafe(1)
    let connected = false
    let providers: typeof ConfigV1.Info.Type.provider | undefined

    const load = Effect.fn("MongolGPTPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active("mongolgpt")
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      connected = connection !== undefined
      providers = credential
        ? yield* fetchProviders(http, credential).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to load MongolGPT provider config", { cause }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined
    })

    yield* ctx.integration.transform((draft) => {
      draft.update("mongolgpt", (integration) => {
        integration.name = "MongolGPT"
      })
      draft.method.update(oauth(http))
      draft.method.update({ integrationID: "mongolgpt", method: { type: "key", label: "API key (service account)" } })
    })

    connected = (yield* ctx.integration.connection.active("mongolgpt")) !== undefined
    yield* ctx.catalog.transform((catalog) => {
      for (const [providerID, item] of Object.entries(providers ?? {})) {
        catalog.provider.update(providerID, (provider) => {
          provider.integrationID = Integration.ID.make("mongolgpt")
          if (item.name !== undefined) provider.name = item.name
          provider.api = item.npm
            ? { type: "aisdk", package: item.npm, url: item.api }
            : { type: "native", url: item.api, settings: {} }
          Object.assign(provider.request.headers, item.options?.headers)
          Object.assign(provider.request.body, withoutCredentials(item.options))
        })

        for (const [modelID, config] of Object.entries(item.models ?? {})) {
          catalog.model.update(providerID, modelID, (model) => {
            if (config.family !== undefined) model.family = config.family
            if (config.name !== undefined) model.name = config.name
            if (config.id !== undefined) model.api.id = config.id
            if (config.provider !== undefined) {
              model.api = config.provider.npm
                ? {
                    id: model.api.id,
                    type: "aisdk",
                    package: config.provider.npm,
                    url: config.provider.api,
                  }
                : { id: model.api.id, type: "native", url: config.provider.api, settings: {} }
            }
            if (config.tool_call !== undefined) model.capabilities.tools = config.tool_call
            if (config.modalities?.input !== undefined) model.capabilities.input = [...config.modalities.input]
            if (config.modalities?.output !== undefined) model.capabilities.output = [...config.modalities.output]
            const packageName = config.provider?.npm ?? item.npm
            const lowerer = ConfigProviderOptionsV1.get(packageName)
            Object.assign(model.request.headers, config.headers)
            Object.assign(model.request.body, lowerer.request(withoutCredentials(config.options)))
            if (config.variants !== undefined) {
              model.variants = Object.entries(config.variants).map(([id, options]) => ({
                id: ModelV2.VariantID.make(id),
                headers: { ...(options.headers ?? {}) },
                body: lowerer.request(withoutCredentials(options)),
              }))
            }
            if (config.release_date !== undefined) {
              const released = Date.parse(config.release_date)
              model.time.released = Number.isFinite(released) ? released : 0
            }
            if (config.cost !== undefined) {
              model.cost = remoteCost(config.cost)
            }
            model.status = config.status ?? "active"
            model.enabled = config.status !== "deprecated"
            if (config.limit !== undefined) model.limit = { ...config.limit }
          })
        }
      }

      const item = catalog.provider.get(ProviderV2.ID.mongolgpt)
      if (!item) return
      const hasKey = Boolean(env("MONGOLGPT_API_KEY") || connected || item.provider.request.body.apiKey)
      catalog.provider.update(item.provider.id, (provider) => {
        if (!hasKey && provider.request.body.apiKey === "public") delete provider.request.body.apiKey
      })
      if (hasKey) return
      for (const model of item.models.values()) {
        catalog.model.update(item.provider.id, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("mongolgpt")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.forkScoped)
  }),
})

function fetchProviders(http: HttpClient.HttpClient, value: CredentialValue) {
  const metadata = value.metadata
  const server = typeof metadata?.server === "string" ? metadata.server : defaultServer
  const orgID = typeof metadata?.orgID === "string" ? metadata.orgID : undefined
  const token = value.type === "oauth" ? value.access : value.key
  return http
    .execute(
      HttpClientRequest.get(`${server}/api/config`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders(orgID ? { "x-org-id": orgID } : {}),
      ),
    )
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.succeed(undefined)
        return HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteResponse)),
          Effect.map((remote) => remote.config.provider),
        )
      }),
    )
}

function withoutCredentials(body: Readonly<Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "apiKey" && key !== "headers"))
}

function remoteCost(input: NonNullable<(typeof ConfigProviderV1.Model.Type)["cost"]>) {
  const base = {
    input: input.input,
    output: input.output,
    cache: { read: input.cache_read ?? 0, write: input.cache_write ?? 0 },
  }
  if (!input.context_over_200k) return [base]
  return [
    base,
    {
      tier: { type: "context" as const, size: 200_000 },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? 0,
        write: input.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}

type Pkce = {
  verifier: string
  challenge: string
}

function exchange(authServer: string, code: string, redirect: string, pkce: Pkce) {
  const decode = Schema.decodeUnknownSync(Token)
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${authServer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          client_id: clientID,
          code_verifier: pkce.verifier,
        }).toString(),
        signal,
      })
      if (!response.ok) throw new Error(`MongolGPT token солилцоо амжилтгүй боллоо: ${response.status}`)
      return decode(await response.json())
    },
    catch: (cause) => cause,
  })
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

function authorizeURL(authServer: string, redirect: string, pkce: Pkce, state: string) {
  return `${authServer}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientID,
    redirect_uri: redirect,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })}`
}

function credential(http: HttpClient.HttpClient, server: string, token: typeof Token.Type) {
  return Effect.gen(function* () {
    const [user, orgs] = yield* Effect.all(
      [
        get(http, `${server}/api/user`, token.access_token, User),
        get(http, `${server}/api/orgs`, token.access_token, Schema.Array(Org)),
      ],
      { concurrency: 2 },
    )
    const org = selectSoleOrganization(orgs)
    return Credential.OAuth.make({
      type: "oauth" as const,
      methodID,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        orgID: org?.id,
        orgName: org?.name,
      },
    })
  })
}

export function selectSoleOrganization(orgs: ReadonlyArray<{ id: string; name: string }>) {
  if (orgs.length !== 1) return
  return orgs[0]
}

function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string>,
  schema: S,
  statusOk = true,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))(body),
    Effect.flatMap((request) => http.execute(request)),
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}
