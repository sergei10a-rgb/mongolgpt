import { describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT } from "jose"
import { previewRequest, type PreviewEnvironment } from "../src/preview/worker"

const origin = "https://preview.dev.mgpt.mn"
const team = "https://raspy-frog-02f6.cloudflareaccess.com"
const audience = "a".repeat(64)
const pair = await generateKeyPair("RS256")
const resolver = async () => pair.publicKey
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ email: "sergei10a@gmail.com", ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(team)
    .setAudience(audience)
    .setSubject("owner-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey)
}
function environment() {
  const seen: Request[] = []
  const assets: Request[] = []
  const env: PreviewEnvironment = {
    STAGE: "dev",
    ACCESS_AUDIENCE: audience,
    ACCESS_TEAM_DOMAIN: team,
    ASSETS: {
      fetch: async (request) => {
        assets.push(request)
        return new Response("app")
      },
    },
    CANDIDATE: {
      fetch: async (request) => {
        seen.push(request)
        return Response.json(
          { native: true },
          { headers: { "Access-Control-Allow-Origin": "https://app.dev.mgpt.mn" } },
        )
      },
    },
  }
  return { env, seen, assets }
}

describe("owner preview boundary", () => {
  test("protects both static assets and native routes before calling bindings", async () => {
    for (const path of ["/", "/assets/app.js", "/api/session", "/global/health"]) {
      const current = environment()
      expect((await previewRequest(new Request(origin + path), current.env, resolver)).status).toBe(403)
      expect(current.seen).toHaveLength(0)
      expect(current.assets).toHaveLength(0)
    }
  })
  test("accepts a signed owner assertion and rejects another user, signature, issuer or audience", async () => {
    const current = environment()
    const owner = await token()
    for (const assertion of [await token({ email: "other@example.com" }), owner + "bad", "not-a-token"]) {
      expect(
        (
          await previewRequest(
            new Request(origin, { headers: { "Cf-Access-Jwt-Assertion": assertion } }),
            current.env,
            resolver,
          )
        ).status,
      ).toBe(403)
    }
    for (const config of [
      { ...current.env, ACCESS_AUDIENCE: "b".repeat(64) },
      { ...current.env, ACCESS_TEAM_DOMAIN: "https://other.cloudflareaccess.com" },
      { ...current.env, STAGE: "production" },
    ]) {
      expect(
        (await previewRequest(new Request(origin, { headers: { "Cf-Access-Jwt-Assertion": owner } }), config, resolver))
          .status,
      ).toBeGreaterThanOrEqual(400)
    }
    expect(
      (
        await previewRequest(
          new Request(origin, { headers: { "Cf-Access-Jwt-Assertion": owner } }),
          current.env,
          resolver,
        )
      ).status,
    ).toBe(200)
    expect(current.assets).toHaveLength(1)
    expect(current.seen).toHaveLength(0)
  })
  test("preserves signed runtime capability audience and only protocol headers through a private binding", async () => {
    const current = environment()
    const response = await previewRequest(
      new Request(origin + "/auth/session", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await token(),
          Origin: origin,
          Authorization: "Bearer legitimate-capability",
          Cookie: "CF_Authorization=private; __Host-mongolgpt-runtime=runtime-cookie; console=private",
          "x-org-id": "forged",
          "x-mongolgpt-gateway-token": "forged",
          "x-forwarded-host": "evil.example",
        },
      }),
      current.env,
      resolver,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(current.seen).toHaveLength(1)
    const upstream = current.seen[0]
    expect(upstream.url).toBe(origin + "/auth/session")
    expect(upstream.redirect).toBe("manual")
    expect(upstream.headers.get("Origin")).toBe("https://app.dev.mgpt.mn")
    expect(upstream.headers.get("Authorization")).toBe("Bearer legitimate-capability")
    expect(upstream.headers.get("Cookie")).toBe("__Host-mongolgpt-runtime=runtime-cookie")
    for (const name of ["Cf-Access-Jwt-Assertion", "x-org-id", "x-mongolgpt-gateway-token", "x-forwarded-host"]) {
      expect(upstream.headers.get(name)).toBeNull()
    }
  })
  test("preserves the native PTY ticket marker without synthesizing or changing it", async () => {
    const assertion = await token()
    for (const marker of [undefined, "1", "invalid"]) {
      const current = environment()
      const headers = new Headers({ "Cf-Access-Jwt-Assertion": assertion, Origin: origin })
      if (marker !== undefined) headers.set("x-mongolgpt-ticket", marker)
      const response = await previewRequest(
        new Request(origin + "/pty/fixture/connect-token?directory=%2Fworkspace", { method: "POST", headers }),
        current.env,
        resolver,
      )
      expect(response.status).toBe(200)
      expect(current.seen).toHaveLength(1)
      expect(current.seen[0].headers.get("x-mongolgpt-ticket")).toBe(marker ?? null)
      expect(current.seen[0].headers.get("Origin")).toBe("https://app.dev.mgpt.mn")
      expect(current.seen[0].headers.get("Cf-Access-Jwt-Assertion")).toBeNull()
    }
  })
  test("a PTY ticket marker cannot bypass owner or origin checks", async () => {
    const assertion = await token()
    for (const headers of [
      new Headers({ Origin: origin }),
      new Headers({ "Cf-Access-Jwt-Assertion": await token({ email: "other@example.com" }), Origin: origin }),
      new Headers({ "Cf-Access-Jwt-Assertion": assertion, Origin: "https://evil.example" }),
      new Headers({ "Cf-Access-Jwt-Assertion": assertion }),
    ]) {
      const current = environment()
      headers.set("x-mongolgpt-ticket", "1")
      const response = await previewRequest(
        new Request(origin + "/pty/fixture/connect-token", {
          method: "POST",
          headers,
        }),
        current.env,
        resolver,
      )
      expect(response.status).toBe(403)
      expect(current.seen).toHaveLength(0)
      expect(current.assets).toHaveLength(0)
    }
  })
  test("same-origin reads without Origin work, cross-origin reads and writes do not", async () => {
    const current = environment()
    const assertion = await token()
    for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
      for (const requestOrigin of ["https://evil.example", "null", ""]) {
        const headers = new Headers({ "Cf-Access-Jwt-Assertion": assertion })
        if (requestOrigin) headers.set("Origin", requestOrigin)
        expect(
          (await previewRequest(new Request(origin + "/api/session", { method, headers }), current.env, resolver))
            .status,
        ).toBe(403)
      }
    }
    expect(current.seen).toHaveLength(0)
    expect(
      (
        await previewRequest(
          new Request(origin + "/api/session", {
            headers: {
              "Cf-Access-Jwt-Assertion": assertion,
              "Sec-Fetch-Site": "same-origin",
            },
          }),
          current.env,
          resolver,
        )
      ).status,
    ).toBe(200)
  })
  test("alternate host and unsupported auth cannot reach either binding", async () => {
    const current = environment()
    const headers = { "Cf-Access-Jwt-Assertion": await token(), Origin: origin }
    expect(
      (
        await previewRequest(
          new Request("https://mongolgpt-preview-dev.example.workers.dev/", { headers }),
          current.env,
          resolver,
        )
      ).status,
    ).toBe(403)
    expect(
      (await previewRequest(new Request(origin + "/auth/runtime-token", { headers }), current.env, resolver)).status,
    ).toBe(404)
    expect(current.seen).toHaveLength(0)
    expect(current.assets).toHaveLength(0)
  })
})
