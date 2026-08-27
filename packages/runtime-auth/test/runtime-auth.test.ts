import { describe, expect, test } from "bun:test"
import { RuntimeCapabilityError, issueRuntimeCapability, verifyRuntimeCapability } from "../src"

const secret = "runtime-capability-secret-at-least-thirty-two-characters"
const otherSecret = "another-runtime-capability-secret-over-thirty-two"
const audience = "https://runtime.dev.mgpt.mn"
const now = 1_700_000_000

const capability = {
  accountID: "acc_123",
  workspaceID: "wrk_123",
  authVersion: 4,
  audience,
  secret,
  now,
  jti: "capability_identifier_123",
}

async function token(overrides: Partial<typeof capability> & { ttlSeconds?: number } = {}) {
  return issueRuntimeCapability({ ...capability, ...overrides })
}

function part(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function base64Url(value: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function signedToken(header: unknown, claims: Record<string, unknown>) {
  const signingInput = `${part(header)}.${part(claims)}`
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)))
  return `${signingInput}.${base64Url(signature)}`
}

describe("runtime capability", () => {
  test("issues and verifies a canonical HS256 runtime capability", async () => {
    const issued = await token({ audience: "https://RUNTIME.dev.mgpt.mn/" })
    const verified = await verifyRuntimeCapability({ token: issued, audience, secret, now })

    expect(issued.split(".")).toHaveLength(3)
    expect(verified).toEqual({
      sub: "acc_123",
      workspaceID: "wrk_123",
      authVersion: 4,
      aud: audience,
      iat: now,
      exp: now + 90,
      jti: "capability_identifier_123",
      v: 1,
    })
  })

  test("rejects a tampered token, wrong secret, and wrong audience", async () => {
    const issued = await token()
    const tampered = `${issued.slice(0, -1)}${issued.endsWith("A") ? "B" : "A"}`

    await expect(verifyRuntimeCapability({ token: tampered, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )
    await expect(verifyRuntimeCapability({ token: issued, audience, secret: otherSecret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )
    await expect(
      verifyRuntimeCapability({ token: issued, audience: "https://runtime.mgpt.mn", secret, now }),
    ).rejects.toBeInstanceOf(RuntimeCapabilityError)
  })

  test("rejects expired claims and claims issued more than five seconds in the future", async () => {
    const issued = await token({ now: now - 91 })
    await expect(verifyRuntimeCapability({ token: issued, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )

    const future = await token({ now: now + 6 })
    await expect(verifyRuntimeCapability({ token: future, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )
  })

  test("enforces issuer and verifier TTL bounds", async () => {
    await expect(token({ ttlSeconds: 59 })).rejects.toBeInstanceOf(RuntimeCapabilityError)
    await expect(token({ ttlSeconds: 121 })).rejects.toBeInstanceOf(RuntimeCapabilityError)

    const longLived = await signedToken(
      { alg: "HS256", typ: "JWT" },
      {
        sub: "acc_123",
        workspaceID: "wrk_123",
        authVersion: 4,
        aud: audience,
        iat: now,
        exp: now + 121,
        jti: "capability_identifier_123",
        v: 1,
      },
    )
    await expect(verifyRuntimeCapability({ token: longLived, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )

    const shortLived = await signedToken(
      { alg: "HS256", typ: "JWT" },
      {
        sub: "acc_123",
        workspaceID: "wrk_123",
        authVersion: 4,
        aud: audience,
        iat: now,
        exp: now + 59,
        jti: "capability_identifier_123",
        v: 1,
      },
    )
    await expect(verifyRuntimeCapability({ token: shortLived, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )
  })

  test("rejects malformed encodings and non-exact headers or claims", async () => {
    const issued = await token()
    const [, payload, signature] = issued.split(".")
    const malformed = [
      "not-a-token",
      `eyJhbGciOiJIUzI1NiJ9.${payload}.${signature}`,
      `${issued}=`,
      `a.${payload}.${signature}`,
    ]
    for (const invalid of malformed) {
      await expect(verifyRuntimeCapability({ token: invalid, audience, secret, now })).rejects.toBeInstanceOf(
        RuntimeCapabilityError,
      )
    }

    const wrongHeader = await signedToken(
      { alg: "none", typ: "JWT" },
      {
        sub: "acc_123",
        workspaceID: "wrk_123",
        authVersion: 4,
        aud: audience,
        iat: now,
        exp: now + 90,
        jti: "capability_identifier_123",
        v: 1,
      },
    )
    await expect(verifyRuntimeCapability({ token: wrongHeader, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )

    const extraClaim = await signedToken(
      { alg: "HS256", typ: "JWT" },
      {
        sub: "acc_123",
        workspaceID: "wrk_123",
        authVersion: 4,
        aud: audience,
        iat: now,
        exp: now + 90,
        jti: "capability_identifier_123",
        v: 1,
        extra: true,
      },
    )
    await expect(verifyRuntimeCapability({ token: extraClaim, audience, secret, now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )
  })

  test("rejects short secrets on issue and verification", async () => {
    await expect(token({ secret: "short" })).rejects.toBeInstanceOf(RuntimeCapabilityError)
    const issued = await token()
    await expect(verifyRuntimeCapability({ token: issued, audience, secret: "short", now })).rejects.toBeInstanceOf(
      RuntimeCapabilityError,
    )
  })

  test("requires a canonical workspace claim", async () => {
    for (const workspaceID of ["", "workspace_123", "wrk_", " wrk_123", `wrk_${"x".repeat(27)}`]) {
      await expect(token({ workspaceID })).rejects.toBeInstanceOf(RuntimeCapabilityError)
    }
  })
})
