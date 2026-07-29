import { describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT } from "jose"
import type { JWTVerifyGetKey } from "jose"
import {
  AdminAccessConfigurationError,
  AdminAccessVerificationError,
  parseAdminAccessConfig,
  verifyCloudflareAccessAssertion,
} from "../src/lib/access"

const config = parseAdminAccessConfig({
  teamDomain: "https://mongolgpt.cloudflareaccess.com",
  audience: "0123456789abcdef",
  bootstrapEmails: "Owner@MGPT.MN, backup@mgpt.mn",
})

describe("Cloudflare Access admin verification", () => {
  test("accepts a valid RS256 assertion and normalizes the email", async () => {
    const keys = await generateKeyPair("RS256")
    const token = await validToken(keys.privateKey, {
      email: "Owner@MGPT.MN",
      sub: "access-user-1",
    })

    await expect(
      verifyCloudflareAccessAssertion(token, config, resolver(keys.publicKey)),
    ).resolves.toMatchObject({
      email: "owner@mgpt.mn",
      subject: "access-user-1",
    })
  })

  test("rejects the wrong audience and issuer", async () => {
    const keys = await generateKeyPair("RS256")
    const audience = await validToken(keys.privateKey, {
      email: "owner@mgpt.mn",
      sub: "access-user-1",
      audience: "another-application",
    })
    const issuer = await validToken(keys.privateKey, {
      email: "owner@mgpt.mn",
      sub: "access-user-1",
      issuer: "https://other.cloudflareaccess.com",
    })

    await expect(
      verifyCloudflareAccessAssertion(audience, config, resolver(keys.publicKey)),
    ).rejects.toBeInstanceOf(AdminAccessVerificationError)
    await expect(
      verifyCloudflareAccessAssertion(issuer, config, resolver(keys.publicKey)),
    ).rejects.toBeInstanceOf(AdminAccessVerificationError)
  })

  test("rejects expired, incomplete, and non-RS256 assertions", async () => {
    const rsa = await generateKeyPair("RS256")
    const ec = await generateKeyPair("ES256")
    const expired = await new SignJWT({
      email: "owner@mgpt.mn",
      sub: "access-user-1",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(config.teamDomain)
      .setAudience(config.audience)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(rsa.privateKey)
    const missingEmail = await validToken(rsa.privateKey, {
      sub: "access-user-1",
    })
    const wrongAlgorithm = await new SignJWT({
      email: "owner@mgpt.mn",
      sub: "access-user-1",
    })
      .setProtectedHeader({ alg: "ES256", kid: "ec-key" })
      .setIssuer(config.teamDomain)
      .setAudience(config.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(ec.privateKey)

    await expect(
      verifyCloudflareAccessAssertion(expired, config, resolver(rsa.publicKey)),
    ).rejects.toBeInstanceOf(AdminAccessVerificationError)
    await expect(
      verifyCloudflareAccessAssertion(missingEmail, config, resolver(rsa.publicKey)),
    ).rejects.toBeInstanceOf(AdminAccessVerificationError)
    await expect(
      verifyCloudflareAccessAssertion(wrongAlgorithm, config, resolver(ec.publicKey)),
    ).rejects.toBeInstanceOf(AdminAccessVerificationError)
  })
})

describe("Cloudflare Access admin configuration", () => {
  test("requires an exact Cloudflare Access HTTPS origin", () => {
    expect(config.teamDomain).toBe("https://mongolgpt.cloudflareaccess.com")
    expect(config.bootstrapEmails).toEqual(new Set(["owner@mgpt.mn", "backup@mgpt.mn"]))
    expect(() =>
      parseAdminAccessConfig({
        teamDomain: "https://mongolgpt.cloudflareaccess.com/path",
        audience: "audience",
        bootstrapEmails: "owner@mgpt.mn",
      }),
    ).toThrow(AdminAccessConfigurationError)
    expect(() =>
      parseAdminAccessConfig({
        teamDomain: "http://mongolgpt.cloudflareaccess.com",
        audience: "audience",
        bootstrapEmails: "owner@mgpt.mn",
      }),
    ).toThrow(AdminAccessConfigurationError)
  })

  test("rejects unsafe audience and bootstrap values", () => {
    expect(() =>
      parseAdminAccessConfig({
        teamDomain: "https://mongolgpt.cloudflareaccess.com",
        audience: "has whitespace",
        bootstrapEmails: "owner@mgpt.mn",
      }),
    ).toThrow("хоосон зай")
    expect(() =>
      parseAdminAccessConfig({
        teamDomain: "https://mongolgpt.cloudflareaccess.com",
        audience: "audience",
        bootstrapEmails: "not-an-email",
      }),
    ).toThrow("имэйл")
  })
})

async function validToken(
  privateKey: CryptoKey,
  input: {
    email?: string
    sub: string
    audience?: string
    issuer?: string
  },
) {
  return new SignJWT({
    email: input.email,
    sub: input.sub,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(input.issuer ?? config.teamDomain)
    .setAudience(input.audience ?? config.audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey)
}

function resolver(publicKey: CryptoKey): JWTVerifyGetKey {
  return async () => publicKey
}
