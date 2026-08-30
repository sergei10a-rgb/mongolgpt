import type { Locale } from "~/lib/language";
import { route } from "~/lib/language";
import { authCallbackTarget } from "./helpers";
import type { OAuthStateSessionData } from "./oauth-state";
import { consumeOAuthState } from "./oauth-state";

type Dictionary = ReturnType<typeof import("~/i18n").i18n>;
type AuthAccountSession = {
  account?: Record<string, { id: string; email: string; authVersion?: number }>;
  current?: string;
  blocked?: "suspended";
};

export async function completeOAuthCallback(input: {
  url: URL;
  locale: Locale;
  dict: Dictionary;
  authClient: {
    exchange(code: string, redirectUri: string): Promise<unknown>;
    verify(token: string): Promise<unknown>;
  };
  authSession: {
    update(
      updater: (value: AuthAccountSession) => AuthAccountSession,
    ): Promise<unknown>;
  };
  oauthStateSession: {
    data: OAuthStateSessionData;
    update(
      updater: (value: OAuthStateSessionData) => OAuthStateSessionData,
    ): Promise<unknown>;
  };
  redirectFn?: (target: string) => Response;
}) {
  const callbackState = input.url.searchParams.get("state");
  let consumed = consumeOAuthState(input.oauthStateSession.data, callbackState);
  await input.oauthStateSession.update((value) => {
    consumed = consumeOAuthState(value, callbackState);
    return consumed.session;
  });
  if (!consumed.validation.ok) {
    return invalidStateResponse(consumed.validation.reason, input.dict);
  }

  const code = input.url.searchParams.get("code");
  if (!code) throw new Error(input.dict["auth.callback.error.codeMissing"]);
  const result = await input.authClient.exchange(
    code,
    `${input.url.origin}${input.url.pathname}`,
  );
  const accessToken = exchangeAccessToken(result);
  const verified = await input.authClient.verify(accessToken);
  const subject = verifiedAccountSubject(
    verified,
    input.dict["auth.callback.error.codeMissing"],
  );
  const id = subject.accountID;
  await input.authSession.update((value) => {
    return {
      ...value,
      account: {
        ...value.account,
        [id]: {
          id,
          email: subject.email,
          authVersion: subject.authVersion ?? 0,
        },
      },
      current: id,
      blocked: undefined,
    };
  });
  const target = route(input.locale, authCallbackTarget(input.url));
  return input.redirectFn
    ? input.redirectFn(target)
    : defaultRedirect(input.url, target);
}

function invalidStateResponse(
  reason: "missing" | "invalid" | "expired",
  dict: Dictionary,
) {
  const message =
    reason === "expired"
      ? "Нэвтрэх оролдлогын хугацаа дууссан байна. Дахин оролдоно уу."
      : "Нэвтрэх оролдлогыг баталгаажуулж чадсангүй. Дахин оролдоно уу.";

  return Response.json(
    {
      error: "invalid_oauth_state",
      message,
      fallback: dict["auth.callback.error.codeMissing"],
    },
    {
      status: 400,
      headers: { "cache-control": "no-store" },
    },
  );
}

function defaultRedirect(requestUrl: URL, target: string) {
  return Response.redirect(new URL(target, requestUrl.origin), 302);
}

function exchangeAccessToken(result: unknown) {
  if (!record(result)) throw new Error("Invalid OAuth exchange response");
  if (result.err) {
    const message =
      record(result.err) && typeof result.err.message === "string"
        ? result.err.message
        : "OAuth exchange failed";
    throw new Error(message);
  }
  if (
    !record(result.tokens) ||
    typeof result.tokens.access !== "string" ||
    !result.tokens.access
  ) {
    throw new Error("Missing OAuth access token");
  }
  return result.tokens.access;
}

function verifiedAccountSubject(result: unknown, fallback: string) {
  if (!record(result)) throw new Error(fallback);
  if (result.err) {
    const message =
      record(result.err) && typeof result.err.message === "string"
        ? result.err.message
        : fallback;
    throw new Error(message);
  }
  if (
    !record(result.subject) ||
    result.subject.type !== "account" ||
    !record(result.subject.properties)
  ) {
    throw new Error(fallback);
  }
  const accountID = result.subject.properties.accountID;
  const email = result.subject.properties.email;
  const authVersion = result.subject.properties.authVersion;
  if (typeof accountID !== "string" || typeof email !== "string")
    throw new Error(fallback);
  if (authVersion !== undefined && typeof authVersion !== "number")
    throw new Error(fallback);
  return { accountID, email, authVersion };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
