import { describe, expect, test } from "bun:test";
import { issueOAuthState, validateOAuthState } from "./oauth-state";

const source = await Bun.file(
  new URL("./oauth-state.ts", import.meta.url),
).text();

describe("OAuth state session", () => {
  test("issues a random callback state and replaces the upstream query value", () => {
    const issued = issueOAuthState(
      "https://auth.dev.mgpt.mn/authorize?client_id=app&redirect_uri=https%3A%2F%2Fdev.mgpt.mn%2Fauth%2Fcallback&response_type=code&state=upstream",
      1_700_000_000_000,
    );

    const url = new URL(issued.authorizationUrl);
    expect(url.searchParams.get("state")).toBe(issued.session.state);
    expect(issued.session.state).not.toBe("upstream");
    expect(issued.session.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.session.expiresAt).toBe(1_700_000_600_000);
  });

  test("accepts only the matching unexpired one-time state", () => {
    const session = { state: "nonce_123", expiresAt: 2_000 };
    expect(validateOAuthState(session, "nonce_123", 1_999)).toEqual({
      ok: true,
    });
    expect(validateOAuthState(session, "other", 1_999)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(validateOAuthState(session, null, 1_999)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(validateOAuthState(session, "nonce_123", 2_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("uses a browser-valid host-only cookie with a root path", () => {
    expect(source).toContain('"__Host-mongolgpt-oauth-state"');
    expect(source).toContain('path: "/"');
    expect(source).not.toContain('"__Secure-mongolgpt-oauth-state"');
    expect(source).not.toContain('from "node:buffer"');
  });
});
