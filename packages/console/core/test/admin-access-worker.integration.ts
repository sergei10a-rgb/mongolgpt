import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
const { adminCompatibility }: typeof import("../../admin/cloudflare.config") = await import(
  new URL("../../admin/cloudflare.config.ts", import.meta.url).href
)

const require = createRequire(import.meta.url)
const { Miniflare, createFetchMock } = createRequire(require.resolve("wrangler/package.json"))("miniflare")
const requireAdmin = createRequire(new URL("../../admin/package.json", import.meta.url))
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(requireAdmin.resolve("jose")).href)
const keys = await generateKeyPair("RS256")
const wrongKeys = await generateKeyPair("RS256")
const ec = await generateKeyPair("ES256")
const issuer = "https://synthetic.cloudflareaccess.com"
const now = Math.floor(Date.now() / 1000)
const claims = {
  email: "Owner@EXAMPLE.TEST",
  sub: "synthetic-admin",
  iss: issuer,
  aud: "synthetic-admin-audience",
  iat: now,
  exp: now + 300,
}
const mock = createFetchMock()
mock.disableNetConnect()
mock
  .get(issuer)
  .intercept({ path: "/cdn-cgi/access/certs", method: "GET" })
  .reply(
    200,
    {
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "synthetic", alg: "RS256", use: "sig" }],
    },
    { headers: { "content-type": "application/json" } },
  )
  .persist()
const sign = (payload: Record<string, unknown> = claims, key = keys.privateKey, alg = "RS256") =>
  new SignJWT(payload).setProtectedHeader({ alg, kid: "synthetic" }).sign(key)
const valid = await sign()
let checks = 0
// The old build date must reproduce the real JOSE/CryptoKey defect, not just a source-string assertion.
for (const date of ["2024-09-19", adminCompatibility.date]) {
  const runtime = new Miniflare({
    modules: true,
    scriptPath: process.argv[2],
    modulesRoot: dirname(process.argv[2]),
    compatibilityDate: date,
    compatibilityFlags: adminCompatibility.flags,
    fetchMock: mock,
  })
  try {
    const request = (token: string) =>
      runtime.dispatchFetch("https://admin.example.test/", {
        headers: { "cf-access-jwt-assertion": token },
      })
    const response = await request(valid)
    assert.equal(response.status, date === "2024-09-19" ? 403 : 200)
    checks++
    if (date === "2024-09-19") continue
    assert.deepEqual(await response.json(), {
      email: "owner@example.test",
      subject: claims.sub,
      expiresAt: claims.exp,
    })
    checks++
    const invalid = [
      "",
      "not-a-jwt",
      "x".repeat(16_385),
      await sign(claims, wrongKeys.privateKey),
      await sign(claims, ec.privateKey, "ES256"),
      await sign({ ...claims, aud: "another-app" }),
      await sign({ ...claims, iss: "https://other.cloudflareaccess.com" }),
      await sign({ ...claims, iat: now - 120, exp: now - 60 }),
      await sign({ ...claims, iat: now + 60 }),
      await sign({ ...claims, exp: now - 1 }),
      await sign({ ...claims, nbf: now + 60 }),
      await sign({ ...claims, email: "invalid-email" }),
      await sign({ ...claims, sub: "" }),
      await sign({ ...claims, sub: "x".repeat(256) }),
    ]
    for (const field of ["email", "sub", "iat", "exp"]) {
      const payload: Record<string, unknown> = { ...claims }
      delete payload[field]
      invalid.push(await sign(payload))
    }
    for (const token of invalid) {
      const denied = await request(token)
      assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { error: "denied" })
      checks += 2
    }
    const repeated = await request(valid)
    assert.equal(repeated.status, 200)
    checks++
  } finally {
    await runtime.dispose()
  }
}
await mock.close()
console.log(`ADMIN_ACCESS_WORKER_RESULT ${JSON.stringify({ ok: true, checks })}`)
