import { describe, expect, test } from "bun:test"
import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "../src/deployment"

const cloudflare = {
  MONGOLGPT_DOMAIN: "mgpt.mn",
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_DEFAULT_ACCOUNT_ID: "test-account",
}
const byok = {
  SST_SECRET_ByokCredentialsKeyV1: "test-byok-key-with-at-least-32-characters",
}
const hosted = {
  ...byok,
  MONGOLGPT_RUNTIME_SECRET: "test-runtime-secret-with-at-least-32-characters",
  SST_SECRET_GITHUB_CLIENT_ID_CONSOLE: "github-client-id",
  SST_SECRET_GITHUB_CLIENT_SECRET_CONSOLE: "github-client-secret",
  SST_SECRET_GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
  SST_SECRET_ZEN_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  SST_SECRET_ZEN_MODELS1: JSON.stringify({
    zenModels: {
      "free-auto": {
        name: "MongolGPT Free Auto",
        cost: { input: 0, output: 0 },
        allowAnonymous: false,
        freeForAuthenticated: true,
        rateLimit: 20,
        freeWeeklyTokenLimit: 100_000,
        freeMaxTokensPerRequest: 32_000,
        fallbackProvider: "nvidia",
        providers: [
          { id: "openrouter", model: "openrouter/auto" },
          { id: "nvidia", model: "nvidia/auto" },
        ],
      },
    },
    liteModels: {},
    providers: {
      openrouter: {
        api: "https://openrouter.ai/api/v1",
        apiKey: "unit-test-provider-key",
      },
      nvidia: {
        api: "https://integrate.api.nvidia.com/v1",
        apiKey: { primary: "unit-test-nvidia-key" },
      },
    },
  }),
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
        ...hosted,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
      },
    })

    expect(result.hostedServices).toBe(true)
    expect(result.stageDomain).toBe("mgpt.mn")
    expect(deploymentEndpoints(result)).toMatchObject({
      app: "https://app.mgpt.mn",
      runtimeHealth: "https://runtime.mgpt.mn/global/health",
    })
  })

  test("requires a strong account-isolation secret for the hosted runtime", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            MONGOLGPT_RUNTIME_SECRET: "too-short",
          },
        }),
      ["MONGOLGPT_RUNTIME_SECRET", "32"],
    )
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
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_ByokCredentialsKeyV1: "too-short",
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
        ...hosted,
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
            ...hosted,
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

  test("rejects incomplete OAuth, session, and Free Auto configuration before SST deploy", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_ByokCredentialsKeyV1: "test-byok-key-with-at-least-32-characters",
          },
        }),
      [
        "GITHUB_CLIENT_ID_CONSOLE",
        "GITHUB_CLIENT_SECRET_CONSOLE",
        "GOOGLE_CLIENT_ID",
        "ZEN_SESSION_SECRET",
        "ZEN_MODELS1",
      ],
    )
  })

  test("rejects common placeholder model, key, and provider endpoint values", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_ZEN_MODELS1: JSON.stringify({
              zenModels: {
                "free-auto": {
                  name: "MongolGPT Free Auto",
                  cost: { input: 0, output: 0 },
                  allowAnonymous: false,
                  freeForAuthenticated: true,
                  rateLimit: 20,
                  freeWeeklyTokenLimit: 1000,
                  freeMaxTokensPerRequest: 100,
                  fallbackProvider: "fallback",
                  providers: [
                    { id: "primary", model: "your-model-id" },
                    { id: "fallback", model: "fallback-model" },
                  ],
                },
              },
              liteModels: {},
              providers: {
                primary: {
                  api: "https://api.example.invalid/v1",
                  apiKey: "your-api-key",
                },
                fallback: {
                  api: "https://fallback.test/v1",
                  apiKey: "sample-api-key",
                },
              },
            }),
          },
        }),
      ["provider route", '"primary" provider бодит API key', '"primary" provider бодит API endpoint'],
    )
  })

  test("rejects placeholder credentials used only by a non-Free-Auto route", () => {
    const models = JSON.parse(hosted.SST_SECRET_ZEN_MODELS1)
    models.liteModels.assistant = {
      name: "Assistant",
      cost: { input: 0, output: 0 },
      providers: [{ id: "sample", model: "sample-model-id" }],
    }
    models.providers.sample = {
      api: "https://provider.example/v1",
      apiKey: "sample-api-key",
    }

    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_ZEN_MODELS1: JSON.stringify(models),
          },
        }),
      ["liteModels.assistant", '"sample" provider бодит API key', '"sample" provider бодит API endpoint'],
    )
  })

  test("uses the same Free Auto contract as the runtime", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_ZEN_MODELS1: JSON.stringify({
              ...JSON.parse(hosted.SST_SECRET_ZEN_MODELS1),
              zenModels: {
                "free-auto": {
                  ...JSON.parse(hosted.SST_SECRET_ZEN_MODELS1).zenModels["free-auto"],
                  rateLimit: undefined,
                },
              },
            }),
          },
        }),
      ["runtime model schema", "rate limit"],
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
