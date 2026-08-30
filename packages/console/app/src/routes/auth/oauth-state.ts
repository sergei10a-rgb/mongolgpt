import { useSession } from "@solidjs/start/http";
import { Resource } from "@mongolgpt/console-resource";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_OAUTH_STATES = 8;

export interface OAuthStateSessionData {
  states?: Record<string, number>;
  // Legacy single-state sessions remain readable during the rollout.
  state?: string;
  expiresAt?: number;
}

type OAuthStateValidation =
  | { ok: true }
  | { ok: false; reason: "missing" | "invalid" | "expired" };

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
): OAuthStateValidation {
  if (!state) return { ok: false, reason: "missing" };
  const match = stateEntries(session).find(([expected]) =>
    sameState(state, expected),
  );
  if (!match) return { ok: false, reason: "invalid" };
  const expiresAt = match[1];
  if (now >= expiresAt) return { ok: false, reason: "expired" };
  return { ok: true };
}

export function recordOAuthState(
  session: OAuthStateSessionData,
  issued: { state: string; expiresAt: number },
  now = Date.now(),
): OAuthStateSessionData {
  const states = new Map(
    stateEntries(session).filter(([, expiresAt]) => expiresAt > now),
  );
  if (
    validState(issued.state) &&
    Number.isSafeInteger(issued.expiresAt) &&
    issued.expiresAt > now
  ) {
    states.set(issued.state, issued.expiresAt);
  }
  const active = [...states]
    .sort((left, right) => left[1] - right[1])
    .slice(-MAX_CONCURRENT_OAUTH_STATES);
  return active.length > 0 ? { states: Object.fromEntries(active) } : {};
}

export function consumeOAuthState(
  session: OAuthStateSessionData,
  state: string | null,
  now = Date.now(),
): { validation: OAuthStateValidation; session: OAuthStateSessionData } {
  const validation = validateOAuthState(session, state, now);
  const active = stateEntries(session).filter(([expected, expiresAt]) => {
    if (expiresAt <= now) return false;
    return !state || !sameState(state, expected);
  });
  return {
    validation,
    session: active.length > 0 ? { states: Object.fromEntries(active) } : {},
  };
}

function stateEntries(session: OAuthStateSessionData) {
  const states = new Map<string, number>();
  if (session.states && typeof session.states === "object") {
    for (const [state, expiresAt] of Object.entries(session.states)) {
      if (validState(state) && Number.isSafeInteger(expiresAt))
        states.set(state, expiresAt);
    }
  }
  if (
    validState(session.state) &&
    session.expiresAt !== undefined &&
    Number.isSafeInteger(session.expiresAt)
  ) {
    states.set(session.state, session.expiresAt);
  }
  return [...states];
}

function validState(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
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
