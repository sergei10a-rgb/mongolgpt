import { describe, expect, test } from "bun:test";
import {
  consumeOAuthState,
  issueOAuthState,
  recordOAuthState,
  validateOAuthState,
} from "./oauth-state";

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

  test("keeps concurrent login states isolated and consumes only the matching state", () => {
    const first = { state: "first_nonce", expiresAt: 3_000 };
    const second = { state: "second_nonce", expiresAt: 4_000 };
    const stored = recordOAuthState(
      recordOAuthState({}, first, 1_000),
      second,
      1_000,
    );

    expect(validateOAuthState(stored, first.state, 1_500)).toEqual({
      ok: true,
    });
    expect(validateOAuthState(stored, second.state, 1_500)).toEqual({
      ok: true,
    });

    const consumed = consumeOAuthState(stored, first.state, 1_500);
    expect(consumed.validation).toEqual({ ok: true });
    expect(validateOAuthState(consumed.session, first.state, 1_500)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(validateOAuthState(consumed.session, second.state, 1_500)).toEqual({
      ok: true,
    });
  });

  test("does not destroy another tab's state when a foreign callback arrives", () => {
    const stored = recordOAuthState(
      {},
      { state: "expected_nonce", expiresAt: 3_000 },
      1_000,
    );
    const consumed = consumeOAuthState(stored, "foreign_nonce", 1_500);

    expect(consumed.validation).toEqual({ ok: false, reason: "invalid" });
    expect(
      validateOAuthState(consumed.session, "expected_nonce", 1_500),
    ).toEqual({ ok: true });
  });

  test("migrates a legacy state and bounds the signed cookie payload", () => {
    let stored: Parameters<typeof recordOAuthState>[0] = {
      state: "legacy_nonce",
      expiresAt: 5_000,
    };
    for (let index = 0; index < 9; index++) {
      stored = recordOAuthState(
        stored,
        { state: `new_nonce_${index}`, expiresAt: 6_000 + index },
        1_000,
      );
    }

    expect(Object.keys(stored.states ?? {})).toHaveLength(8);
    expect(validateOAuthState(stored, "legacy_nonce", 1_500)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(validateOAuthState(stored, "new_nonce_8", 1_500)).toEqual({
      ok: true,
    });
  });

  test("uses a browser-valid host-only cookie with a root path", () => {
    expect(source).toContain('"__Host-mongolgpt-oauth-state"');
    expect(source).toContain('path: "/"');
    expect(source).not.toContain('"__Secure-mongolgpt-oauth-state"');
    expect(source).not.toContain('from "node:buffer"');
  });
});
