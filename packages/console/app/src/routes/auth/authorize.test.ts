import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OAuthStateSessionData } from "./oauth-state";

const authorizeMock = mock(async (_redirectURI: string, _response: "code" | "token") => ({
  url: "https://auth.dev.mgpt.mn/authorize?client_id=app&redirect_uri=https%3A%2F%2Fdev.mgpt.mn%2Fauth%2Fcallback%2Fauth%2Fapp&response_type=code&state=upstream",
}));

const oauthStateUpdates: OAuthStateSessionData[] = [];
const previousAuthUrl = process.env.VITE_AUTH_URL;
process.env.VITE_AUTH_URL = "https://auth.dev.mgpt.mn";

await mock.module("~/context/auth", () => ({
  AuthClient: {
    authorize: authorizeMock,
  },
}));

await mock.module("~/lib/hosted-env", () => ({
  hostedConsoleUrl: "https://dev.mgpt.mn",
  hostedTurnstileEnabled: true,
  hostedTurnstileSiteKey: "1x00000000000000000000AA",
}));

const authorizeRoute = await import("./authorize");
const { GET } = authorizeRoute;
const { authorizationTarget } = await import("./authorization-target");

afterAll(() => {
  if (previousAuthUrl === undefined) delete process.env.VITE_AUTH_URL;
  else process.env.VITE_AUTH_URL = previousAuthUrl;
});

describe("OAuth authorize route", () => {
  beforeEach(() => {
    authorizeMock.mockClear();
    oauthStateUpdates.length = 0;
  });

  test("keeps production helper logic outside the SolidStart method route", () => {
    expect(Object.keys(authorizeRoute)).toEqual(["GET"]);
  });

  test("labels a foreign request origin without exposing either URL", async () => {
    const response = await GET({
      request: new Request("https://alias.dev.mgpt.mn/auth/authorize"),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_authorization_request",
      stage: "origin_mismatch",
      message: "Нэвтрэх хүсэлт буруу байна.",
    });
  });

  test("labels an unsupported explicit client as an invalid CLI request", async () => {
    const response = await GET({
      request: new Request("https://dev.mgpt.mn/auth/authorize?client_id=foreign"),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_authorization_request",
      stage: "cli_request",
    });
  });

  test("allows the configured OAuth provider redirect chain in the challenge CSP", async () => {
    const query = new URLSearchParams({
      client_id: "mongolgpt-cli",
      redirect_uri: "http://127.0.0.1:1456/auth/callback",
      response_type: "code",
      state: "12345678-1234-1234-1234-123456789012",
      code_challenge: "r0Z3xQJf4wK8DZmTsCyuLgVbA9hN6pEeU2iO7sMxP1k",
      code_challenge_method: "S256",
    });
    const response = await GET({
      request: new Request(`https://dev.mgpt.mn/auth/authorize?${query}`),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action https://auth.dev.mgpt.mn https://github.com https://accounts.google.com http://127.0.0.1:1456",
    );
    expect(response.headers.get("content-security-policy")).toMatch(
      /script-src 'nonce-[A-Za-z0-9_-]{16,128}' https:\/\/challenges\.cloudflare\.com/,
    );
    expect(response.headers.get("content-security-policy")).not.toContain("script-src 'unsafe-inline'");
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
    expect(oauthStateUpdates[0]?.states?.[state!]).toBeNumber();
    expect(order).toEqual(["session", "authorize", "update"]);
  });

  test("preserves an active state when another login tab starts", async () => {
    const existing: OAuthStateSessionData = {
      states: { existing_nonce: Date.now() + 60_000 },
    };
    let updated: OAuthStateSessionData = {};

    const target = await authorizationTarget(
      new URL("https://dev.mgpt.mn/auth/authorize"),
      "/auth/app",
      {
        authorize: authorizeMock,
        stateSession: async () => ({
          update: async (updater) => {
            updated = updater(existing);
          },
        }),
      },
    );
    const issuedState = new URL(target).searchParams.get("state");

    expect(issuedState).toBeTruthy();
    expect(updated.states?.existing_nonce).toBe(
      existing.states?.existing_nonce,
    );
    expect(updated.states?.[issuedState!]).toBeNumber();
  });

  test("labels state-session failures without exposing the underlying error", async () => {
    const stages: string[] = [];
    await expect(
      authorizationTarget(
        new URL("https://dev.mgpt.mn/auth/authorize"),
        "/auth/app",
        {
          stateSession: async () => {
            throw new Error("secret session detail");
          },
          onStage: (stage) => stages.push(stage),
        },
      ),
    ).rejects.toThrow("secret session detail");
    expect(stages).toEqual(["state_session"]);
  });

  test("labels state persistence failures", async () => {
    const stages: string[] = [];
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
          onStage: (stage) => stages.push(stage),
        },
      ),
    ).rejects.toThrow("cookie write failed");
    expect(stages).toEqual(["state_session", "authorization_url", "state_issue", "state_store"]);
  });
});
