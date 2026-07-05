export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@mongolgpt/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

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

export class Config extends ConfigService.Service<Config>()("@mongolgpt/ServerAuthConfig", {
  password: configString("MONGOLGPT_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: configString("MONGOLGPT_SERVER_USERNAME").pipe(EffectConfig.withDefault("mongolgpt")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

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
  const password = credentials?.password ?? Flag.MONGOLGPT_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.MONGOLGPT_SERVER_USERNAME ?? "mongolgpt"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
