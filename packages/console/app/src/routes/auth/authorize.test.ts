import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OAuthStateSessionData } from "./oauth-state";

const authorizeMock = mock(async (_redirectURI: string, _response: "code" | "token") => ({
  url: "https://auth.dev.mgpt.mn/authorize?client_id=app&redirect_uri=https%3A%2F%2Fdev.mgpt.mn%2Fauth%2Fcallback%2Fauth%2Fapp&response_type=code&state=upstream",
}));

const oauthStateUpdates: OAuthStateSessionData[] = [];

await mock.module("~/context/auth", () => ({
  AuthClient: {
    authorize: authorizeMock,
  },
}));

await mock.module("~/lib/hosted-env", () => ({
  hostedConsoleUrl: "https://dev.mgpt.mn",
  hostedTurnstileEnabled: false,
  hostedTurnstileSiteKey: undefined,
}));

const { authorizationTarget } = await import("./authorize");

describe("OAuth authorize route", () => {
  beforeEach(() => {
    authorizeMock.mockClear();
    oauthStateUpdates.length = 0;
  });

  test("stores a one-time state in session and redirects with the issued callback state", async () => {
    const order: string[] = [];
    const target = await authorizationTarget(
      new URL("https://dev.mgpt.mn/auth/authorize"),
      "/auth/app",
      {
        authorize: async (...input) => {
          order.push("authorize");
          return authorizeMock(...input);
        },
        stateSession: async () => {
          order.push("session");
          return {
            update: async (value) => {
              order.push("update");
              oauthStateUpdates.push(value({}));
            },
          };
        },
      },
    );

    expect(authorizeMock).toHaveBeenCalledTimes(1);
    expect(authorizeMock.mock.calls[0]?.[0] ?? null).toBe(
      "https://dev.mgpt.mn/auth/callback/auth/app",
    );
    expect(oauthStateUpdates).toHaveLength(1);

    const redirected = new URL(target);
    const state = redirected.searchParams.get("state");
    expect(state).not.toBe("upstream");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toBe(oauthStateUpdates[0]?.state ?? null);
    expect(order).toEqual(["session", "authorize", "update"]);
  });

  test("labels state-session failures without exposing the underlying error", async () => {
    await expect(
      authorizationTarget(
        new URL("https://dev.mgpt.mn/auth/authorize"),
        "/auth/app",
        {
          stateSession: async () => {
            throw new Error("secret session detail");
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "OAuthAuthorizationTargetError",
      stage: "state_session",
      causeName: "Error",
    });
  });

  test("labels state persistence failures", async () => {
    await expect(
      authorizationTarget(
        new URL("https://dev.mgpt.mn/auth/authorize"),
        "/auth/app",
        {
          stateSession: async () => ({
            update: async () => {
              throw new TypeError("cookie write failed");
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: "OAuthAuthorizationTargetError",
      stage: "state_store",
      causeName: "TypeError",
    });
  });
});
