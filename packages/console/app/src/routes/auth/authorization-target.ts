import { AuthClient } from "~/context/auth"
import { issueOAuthState, recordOAuthState, type OAuthStateSessionData, useOAuthStateSession } from "./oauth-state"

export type OAuthAuthorizationStage =
  | "authorization_target"
  | "state_session"
  | "authorization_url"
  | "state_issue"
  | "state_store"

export async function authorizationTarget(
  requestUrl: URL,
  cont: string,
  dependencies: {
    authorize?: (redirectURI: string, response: "code" | "token") => Promise<{ url: string }>
    stateSession?: () => Promise<{
      update(updater: (value: OAuthStateSessionData) => OAuthStateSessionData): Promise<unknown>
    }>
    onStage?: (stage: OAuthAuthorizationStage) => void
  } = {},
) {
  const callbackUrl = `${requestUrl.origin}/auth/callback${cont}`
  const authorize = dependencies.authorize ?? ((...input) => AuthClient.authorize(...input))
  const session = await stage("state_session", () => (dependencies.stateSession ?? useOAuthStateSession)(), dependencies.onStage)
  const result = await stage(
    "authorization_url",
    () => authorize(callbackUrl, "code"),
    dependencies.onStage,
  )
  const issued = await stage("state_issue", () => issueOAuthState(result.url), dependencies.onStage)
  await stage(
    "state_store",
    () => session.update((value) => recordOAuthState(value, issued.session)),
    dependencies.onStage,
  )
  return issued.authorizationUrl
}

async function stage<T>(
  name: OAuthAuthorizationStage,
  operation: () => T | Promise<T>,
  onStage?: (stage: OAuthAuthorizationStage) => void,
) {
  onStage?.(name)
  return operation()
}
