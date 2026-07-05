export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

const env = (key: string) =>
  process.env[key.startsWith("MONGOLGPT_") ? `MONGOLGPT_${key.slice("MONGOLGPT_".length)}` : key] ?? process.env[key]
const configString = (name: string) =>
  EffectConfig.string(name.startsWith("MONGOLGPT_") ? `MONGOLGPT_${name.slice("MONGOLGPT_".length)}` : name).pipe(
    EffectConfig.orElse(() => EffectConfig.string(name)),
  )

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@mongolgpt/ServerAuthConfig") {
  static layer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get defaultLayer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: configString("MONGOLGPT_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: configString("MONGOLGPT_SERVER_USERNAME").pipe(EffectConfig.withDefault("mongolgpt")),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? env("MONGOLGPT_SERVER_PASSWORD")
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? env("MONGOLGPT_SERVER_USERNAME") ?? "mongolgpt"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
