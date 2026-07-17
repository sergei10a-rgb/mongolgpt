import { describe, expect, test } from "bun:test"
import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "../src/deployment"

const cloudflare = {
  MONGOLGPT_DOMAIN: "mgpt.mn",
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_DEFAULT_ACCOUNT_ID: "test-account",
}
const byok = {
  BYOK_CREDENTIALS_KEY_V1: "test-byok-key-with-at-least-32-characters",
}

describe("Cloudflare deployment preflight", () => {
  test("accepts a static dev deployment and derives its endpoints", () => {
    const result = preflightDeployment({ stage: "dev", env: cloudflare })

    expect(result).toMatchObject({
      domain: "mgpt.mn",
      stageDomain: "dev.mgpt.mn",
      hostedServices: false,
    })
    expect(deploymentEndpoints(result)).toEqual({
      docs: "https://docs.dev.mgpt.mn/docs",
      app: "https://app.dev.mgpt.mn",
    })
  })

  test("rejects placeholders, DuckDNS, and missing Cloudflare credentials", () => {
    expectIssues(
      () => preflightDeployment({ stage: "dev", env: { MONGOLGPT_DOMAIN: "mongolgpt.duckdns.org" } }),
      ["DuckDNS", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_DEFAULT_ACCOUNT_ID"],
    )
  })

  test("requires an exact production confirmation", () => {
    expectIssues(() => preflightDeployment({ stage: "production", env: cloudflare }), ["DEPLOY mgpt.mn"])

    expect(
      preflightDeployment({
        stage: "production",
        env: { ...cloudflare, MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn" },
      }).stageDomain,
    ).toBe("mgpt.mn")
  })

  test("accepts hosted production after exact confirmation", () => {
    const result = preflightDeployment({
      stage: "production",
      env: {
        ...cloudflare,
        ...byok,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
      },
    })

    expect(result.hostedServices).toBe(true)
    expect(result.stageDomain).toBe("mgpt.mn")
  })

  test("requires a dev OAuth allowlist for hosted services", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
          },
        }),
      ["MONGOLGPT_AUTH_EMAIL_DOMAINS", "BYOK_CREDENTIALS_KEY_V1"],
    )
  })

  test("rejects a short BYOK vault key for hosted services", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            BYOK_CREDENTIALS_KEY_V1: "too-short",
          },
        }),
      ["BYOK_CREDENTIALS_KEY_V1", "32"],
    )
  })

  test("allows analytics only with hosted services and still rejects legacy Stripe", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_ANALYTICS: "true",
          },
        }),
      ["MONGOLGPT_ENABLE_ANALYTICS", "hosted service"],
    )

    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        ...byok,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_ENABLE_ANALYTICS: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
      },
    })

    expect(result.hostedServices).toBe(true)

    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...byok,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ANALYTICS: "true",
            MONGOLGPT_ENABLE_LEGACY_STRIPE: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          },
        }),
      ["Legacy Stripe"],
    )
  })

  test("rejects non-canonical boolean values", () => {
    expectIssues(
      () => preflightDeployment({ stage: "dev", env: { ...cloudflare, MONGOLGPT_ENABLE_HOSTED_SERVICES: "TRUE" } }),
      ["MONGOLGPT_ENABLE_HOSTED_SERVICES"],
    )
  })
})

function expectIssues(run: () => unknown, fragments: string[]) {
  try {
    run()
    throw new Error("Expected preflight to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(DeploymentPreflightError)
    const message = error instanceof Error ? error.message : String(error)
    for (const fragment of fragments) expect(message).toContain(fragment)
  }
}
