import { useSession } from "@solidjs/start/http";
import { Resource } from "@mongolgpt/console-resource";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateSessionData {
  state?: string;
  expiresAt?: number;
}

export function useOAuthStateSession() {
  return useSession<OAuthStateSessionData>({
    password: Resource.MONGOLGPT_GATEWAY_SESSION_SECRET.value,
    name: import.meta.env.PROD
      ? "__Host-mongolgpt-oauth-state"
      : "mongolgpt-oauth-state",
    maxAge: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
    cookie: {
      secure: import.meta.env.PROD,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  });
}

export function issueOAuthState(authorizationUrl: string, now = Date.now()) {
  const state = randomState();
  const expiresAt = now + OAUTH_STATE_TTL_MS;
  const url = new URL(authorizationUrl);
  url.searchParams.set("state", state);
  return {
    authorizationUrl: url.toString(),
    session: { state, expiresAt },
  };
}

export function validateOAuthState(
  session: OAuthStateSessionData,
  state: string | null,
  now = Date.now(),
): { ok: true } | { ok: false; reason: "missing" | "invalid" | "expired" } {
  if (!state) return { ok: false, reason: "missing" };
  const expectedState = session.state;
  const expiresAt = session.expiresAt;
  if (typeof expectedState !== "string" || !expectedState)
    return { ok: false, reason: "invalid" };
  if (expiresAt === undefined || !Number.isSafeInteger(expiresAt))
    return { ok: false, reason: "invalid" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };
  if (!sameState(state, expectedState)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sameState(actual: string, expected: string) {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
