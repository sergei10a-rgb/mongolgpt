import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { i18n } from "~/i18n";
import { completeOAuthCallback } from "./callback-handler";
import type { OAuthStateSessionData } from "./oauth-state";

const exchangeMock = mock(async () => ({ tokens: { access: "access-token" } }));
const verifyMock = mock(async () => ({
  subject: {
    type: "account",
    properties: {
      accountID: "acc_callback",
      email: "user@mgpt.mn",
      authVersion: 3,
    },
  },
}));

const authSessionUpdates: Array<Record<string, unknown>> = [];
let oauthSessionData: OAuthStateSessionData = {};
let oauthClears = 0;

describe("OAuth callback route", () => {
  beforeEach(() => {
    exchangeMock.mockClear();
    verifyMock.mockClear();
    authSessionUpdates.length = 0;
    oauthClears = 0;
    oauthSessionData = {};
  });

  test("rejects a mismatched callback state before code exchange and clears the one-time session", async () => {
    oauthSessionData = {
      state: "expected-state",
      expiresAt: Date.now() + 60_000,
    };
    const response = await completeOAuthCallback({
      url: new URL(
        "https://dev.mgpt.mn/auth/callback/auth/app?code=secret&state=wrong-state",
      ),
      locale: "mn",
      dict: i18n("mn"),
      authClient: { exchange: exchangeMock, verify: verifyMock },
      authSession: {
        update: async (value) => {
          authSessionUpdates.push(value({}));
        },
      },
      oauthStateSession: {
        data: oauthSessionData,
        clear: async () => {
          oauthClears++;
          oauthSessionData = {};
        },
      },
      redirectFn: (target) => Response.redirect(target, 302),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_oauth_state",
    });
    expect(exchangeMock).toHaveBeenCalledTimes(0);
    expect(oauthClears).toBe(1);
    expect(oauthSessionData).toEqual({});
  });

  test("accepts the matching callback state exactly once, then stores the verified account", async () => {
    oauthSessionData = {
      state: "expected-state",
      expiresAt: Date.now() + 60_000,
    };
    const response = await completeOAuthCallback({
      url: new URL(
        "https://dev.mgpt.mn/auth/callback/auth/app?code=secret&state=expected-state",
      ),
      locale: "mn",
      dict: i18n("mn"),
      authClient: { exchange: exchangeMock, verify: verifyMock },
      authSession: {
        update: async (value) => {
          authSessionUpdates.push(value({}));
        },
      },
      oauthStateSession: {
        data: oauthSessionData,
        clear: async () => {
          oauthClears++;
          oauthSessionData = {};
        },
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://dev.mgpt.mn/auth/app",
    );
    expect(exchangeMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(oauthClears).toBe(1);
    expect(authSessionUpdates).toHaveLength(1);
    expect(authSessionUpdates[0]).toEqual({
      account: {
        acc_callback: {
          authVersion: 3,
          email: "user@mgpt.mn",
          id: "acc_callback",
        },
      },
      blocked: undefined,
      current: "acc_callback",
    });

    const replay = await completeOAuthCallback({
      url: new URL(
        "https://dev.mgpt.mn/auth/callback/auth/app?code=secret&state=expected-state",
      ),
      locale: "mn",
      dict: i18n("mn"),
      authClient: { exchange: exchangeMock, verify: verifyMock },
      authSession: {
        update: async (value) => {
          authSessionUpdates.push(value({}));
        },
      },
      oauthStateSession: {
        data: oauthSessionData,
        clear: async () => {
          oauthClears++;
          oauthSessionData = {};
        },
      },
      redirectFn: (target) => Response.redirect(target, 302),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_oauth_state" });
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });

  test("awaits the callback so the route can localize asynchronous failures", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "[...callback].ts"),
    ).text();

    expect(source).toContain("return await completeOAuthCallback({");
  });
});
