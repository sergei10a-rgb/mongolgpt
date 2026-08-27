import { describe, expect, test } from "bun:test"
import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "../src/deployment"
import { inspectDeploymentStage, requireDeploymentStage } from "../src/deployment-stage"

const cloudflare = {
  MONGOLGPT_DOMAIN: "mgpt.mn",
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_DEFAULT_ACCOUNT_ID: "test-account",
}
const byok = {
  SST_SECRET_ByokCredentialsKeyV1: "test-byok-key-with-at-least-32-characters",
}
const planLimits = {
  free: {
    promoTokens: 1_000,
    dailyRequests: 20,
    dailyRequestsFallback: 5,
    checkHeaders: { "x-mongolgpt-proxy": "unit-test-proxy-secret" },
  },
  lite: {
    rollingLimit: 1,
    rollingWindow: 5,
    weeklyLimit: 5,
    monthlyLimit: 10,
  },
  plans: {
    basic: {
      weeklyCostLimit: 1,
      weeklyTokenLimit: 100_000,
      weeklyRequestLimit: 100,
      monthlyCostLimit: 4,
      monthlyTokenLimit: 400_000,
      monthlyRequestLimit: 400,
      rollingCostLimit: 1,
      rollingWindow: 5,
    },
    pro: {
      weeklyCostLimit: 5,
      weeklyTokenLimit: 500_000,
      weeklyRequestLimit: 500,
      monthlyCostLimit: 20,
      monthlyTokenLimit: 2_000_000,
      monthlyRequestLimit: 2_000,
      rollingCostLimit: 2,
      rollingWindow: 5,
    },
    max: {
      weeklyCostLimit: 10,
      weeklyTokenLimit: 1_000_000,
      weeklyRequestLimit: 1_000,
      monthlyCostLimit: 40,
      monthlyTokenLimit: 4_000_000,
      monthlyRequestLimit: 4_000,
      rollingCostLimit: 4,
      rollingWindow: 5,
    },
  },
}
const hosted = {
  ...byok,
  MONGOLGPT_ENABLE_D1_BACKUPS: "true",
  MONGOLGPT_ENABLE_MONITORING: "true",
  MONGOLGPT_ENABLE_TURNSTILE: "true",
  MONGOLGPT_TURNSTILE_SITE_KEY: "0x4AAAAAAABBBBBBBBCCCCCCCC",
  MONGOLGPT_RUNTIME_SECRET: "test-runtime-secret-with-at-least-32-characters",
  MONGOLGPT_RUNTIME_AUTH_SECRET: "test-runtime-auth-secret-with-at-least-32-characters",
  SST_SECRET_MongolGPTRuntimeAuthSecret: "test-runtime-auth-secret-with-at-least-32-characters",
  SST_SECRET_TurnstileSecretKey: "0x4AAAAAAABBBBBBBBCCCCCCCCDDDDDDDD",
  SST_SECRET_D1BackupApiToken: "test-d1-backup-token",
  SST_SECRET_GITHUB_CLIENT_ID_CONSOLE: "github-client-id",
  SST_SECRET_GITHUB_CLIENT_SECRET_CONSOLE: "github-client-secret",
  SST_SECRET_GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
  SST_SECRET_MONGOLGPT_PLAN_LIMITS: JSON.stringify(planLimits),
  SST_SECRET_MONGOLGPT_GATEWAY_SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify({
    models: {
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
    lightweightModels: {},
    providers: {
      openrouter: {
        api: "https://openrouter.ai/api/v1",
        apiKey: "unit-test-provider-key",
        providerKind: "openrouter",
        usageMode: "managed",
        productionUseApproved: true,
      },
      nvidia: {
        api: "https://integrate.api.nvidia.com/v1",
        apiKey: { primary: "unit-test-nvidia-key" },
        providerKind: "nvidia-nim",
        usageMode: "managed",
        productionUseApproved: true,
      },
    },
  }),
}
const paymentCatalog = JSON.stringify({
  basic: { label: "Basic", amount: 29_900 },
  pro: { label: "Pro", amount: 79_900 },
  max: { label: "Max", amount: 199_900 },
})
const payment = {
  MONGOLGPT_PAYMENT_ENVIRONMENT: "sandbox",
  MONGOLGPT_PAYMENT_PLAN_CATALOG: paymentCatalog,
  SST_SECRET_QPayMerchantAccountID: "unit-qpay-merchant",
  SST_SECRET_QPayClientID: "unit-qpay-client",
  SST_SECRET_QPayClientSecret: "unit-qpay-client-secret",
  SST_SECRET_QPayInvoiceCode: "unit-qpay-invoice",
  SST_SECRET_BonumMerchantAccountID: "unit-bonum-merchant",
  SST_SECRET_BonumAppSecret: "unit-bonum-app-secret",
  SST_SECRET_BonumTerminalID: "12345678",
  SST_SECRET_BonumWebhookChecksumKey: "unit-bonum-webhook-key",
}

describe("Cloudflare deployment preflight", () => {
  test("rejects stage names that SST would interpret differently", () => {
    expect(inspectDeploymentStage("dev")).toEqual({ stage: "dev", issue: undefined })
    expect(inspectDeploymentStage("DEV").stage).toBe("dev")
    expect(() => requireDeploymentStage("DEV")).toThrow("жижиг латин үсэг")
    expectIssues(() => preflightDeployment({ stage: "DEV", env: cloudflare }), ["Deployment stage"])
  })

  test("accepts a static dev deployment and derives its endpoints", () => {
    const result = preflightDeployment({ stage: "dev", env: cloudflare })

    expect(result).toMatchObject({
      domain: "mgpt.mn",
      stageDomain: "dev.mgpt.mn",
      hostedServices: false,
      adminEnabled: false,
      backupsEnabled: false,
      monitoringEnabled: false,
      turnstileEnabled: false,
      paymentEnvironment: "disabled",
    })
    expect(deploymentEndpoints(result)).toEqual({
      docs: "https://docs.dev.mgpt.mn/docs",
      app: "https://app.dev.mgpt.mn",
    })
  })

  test("does not publish a local-bridge build as the public SaaS app", () => {
    expectIssues(
      () => preflightDeployment({ stage: "dev", env: cloudflare, requireHostedServices: true }),
      ["MONGOLGPT_ENABLE_HOSTED_SERVICES=true", "local-bridge build-ийг SaaS app гэж нийтлэхгүй"],
    )
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
        MONGOLGPT_ENABLE_ADMIN: "true",
        CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
        SST_SECRET_MongolGPTAdminBootstrapEmails: "owner@mgpt.mn",
        MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
      },
    })

    expect(result.hostedServices).toBe(true)
    expect(result.stageDomain).toBe("mgpt.mn")
    expect(deploymentEndpoints(result)).toMatchObject({
      app: "https://app.mgpt.mn",
      runtimeHealth: "https://runtime.mgpt.mn/global/health",
      paymentHealth: "https://pay.mgpt.mn/health",
      admin: "https://admin.mgpt.mn",
    })
  })

  test("accepts a complete Bonum and QPay sandbox configuration", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        ...hosted,
        ...payment,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
      },
    })

    expect(result.paymentEnvironment).toBe("sandbox")
    expect(deploymentEndpoints(result).paymentHealth).toBe("https://pay.dev.mgpt.mn/health")
  })

  test("fails closed when sandbox prices or merchant credentials are missing", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            MONGOLGPT_PAYMENT_ENVIRONMENT: "sandbox",
          },
        }),
      ["MONGOLGPT_PAYMENT_PLAN_CATALOG", "QPayMerchantAccountID", "BonumWebhookChecksumKey"],
    )
  })

  test("lets smoke derive payment endpoints without receiving deploy secrets", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
        MONGOLGPT_PAYMENT_ENVIRONMENT: "sandbox",
        MONGOLGPT_PAYMENT_PLAN_CATALOG: paymentCatalog,
      },
      requireCloudflareCredentials: false,
      requireDeploymentSecrets: false,
    })

    expect(result.paymentEnvironment).toBe("sandbox")
    expect(deploymentEndpoints(result).paymentHealth).toBe("https://pay.dev.mgpt.mn/health")
  })

  test("requires explicit production payment approval", () => {
    const env = {
      ...cloudflare,
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_ENABLE_ADMIN: "true",
      MONGOLGPT_ENABLE_D1_BACKUPS: "true",
      MONGOLGPT_ENABLE_MONITORING: "true",
      MONGOLGPT_ENABLE_TURNSTILE: "true",
      MONGOLGPT_TURNSTILE_SITE_KEY: hosted.MONGOLGPT_TURNSTILE_SITE_KEY,
      MONGOLGPT_PAYMENT_ENVIRONMENT: "production",
      MONGOLGPT_PAYMENT_PLAN_CATALOG: paymentCatalog,
      MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
    }

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env,
          requireDeploymentSecrets: false,
        }),
      ["MONGOLGPT_ENABLE_REAL_PAYMENTS=true", "ENABLE REAL PAYMENTS mgpt.mn"],
    )

    expect(
      preflightDeployment({
        stage: "production",
        env: {
          ...env,
          MONGOLGPT_ENABLE_REAL_PAYMENTS: "true",
          MONGOLGPT_REAL_PAYMENT_CONFIRMATION: "ENABLE REAL PAYMENTS mgpt.mn",
        },
        requireDeploymentSecrets: false,
      }).paymentEnvironment,
    ).toBe("production")
  })

  test("requires a protected admin for production hosted launches", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
          },
        }),
      ["MONGOLGPT_ENABLE_ADMIN=true"],
    )
  })

  test("requires the dedicated Cloudflare Access token and admin allowlist", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            SST_SECRET_MongolGPTAdminBootstrapEmails: "not-an-email",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          },
        }),
      ["CLOUDFLARE_ACCESS_API_TOKEN", "хүчинтэй email"],
    )
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

  test("requires one matching capability secret for the console issuer and runtime verifier", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_MongolGPTRuntimeAuthSecret: "different-runtime-auth-secret-with-at-least-32-characters",
          },
        }),
      ["MONGOLGPT_RUNTIME_AUTH_SECRET", "SST_SECRET_MongolGPTRuntimeAuthSecret", "ижил утгатай"],
    )
  })

  test("requires a dedicated D1 export token for hosted backups", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_D1BackupApiToken: "",
          },
        }),
      ["D1_BACKUP_API_TOKEN"],
    )
  })

  test("allows hosted dev deploys to skip backup automation and its production token", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        ...hosted,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_ENABLE_D1_BACKUPS: "false",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
        SST_SECRET_D1BackupApiToken: "",
      },
    })

    expect(result.backupsEnabled).toBe(false)
    expect(result.warnings).toContain("Энэ орчинд өдөр тутмын D1 нөөцлөлтийн автомат ажиллагаа идэвхгүй байна.")
  })

  test("requires backup automation for production hosted launch", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_ENABLE_D1_BACKUPS: "false",
            CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
            SST_SECRET_MongolGPTAdminBootstrapEmails: "admin@mgpt.mn",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
          },
        }),
      ["Үйлдвэрлэлийн үйлчилгээ байршуулалтад", "MONGOLGPT_ENABLE_D1_BACKUPS=true"],
    )
  })

  test("requires Cloudflare service monitoring for production hosted launch", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_ENABLE_MONITORING: "false",
            CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
            SST_SECRET_MongolGPTAdminBootstrapEmails: "admin@mgpt.mn",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
          },
        }),
      ["Үйлдвэрлэлийн үйлчилгээ байршуулалтад", "MONGOLGPT_ENABLE_MONITORING=true"],
    )
  })

  test("requires real Cloudflare Turnstile keys for a production hosted launch", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_ENABLE_TURNSTILE: "false",
            CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
            SST_SECRET_MongolGPTAdminBootstrapEmails: "admin@mgpt.mn",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
          },
        }),
      ["MONGOLGPT_ENABLE_TURNSTILE=true"],
    )

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            SST_SECRET_TurnstileSecretKey: "1x0000000000000000000000000000000AA",
            CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
            SST_SECRET_MongolGPTAdminBootstrapEmails: "admin@mgpt.mn",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
          },
        }),
      ["test key-г production орчинд ашиглахгүй"],
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
        "MONGOLGPT_PLAN_LIMITS",
        "MONGOLGPT_GATEWAY_SESSION_SECRET",
        "MONGOLGPT_GATEWAY_MODELS1",
      ],
    )
  })

  test("accepts the legacy gateway secrets only as a migration fallback", () => {
    const {
      SST_SECRET_MONGOLGPT_GATEWAY_SESSION_SECRET: sessionSecret,
      SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: modelConfig,
      ...withoutCanonicalGatewaySecrets
    } = hosted

    expect(() =>
      preflightDeployment({
        stage: "dev",
        env: {
          ...cloudflare,
          ...withoutCanonicalGatewaySecrets,
          MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
          MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          SST_SECRET_ZEN_SESSION_SECRET: sessionSecret,
          SST_SECRET_ZEN_MODELS1: modelConfig,
        },
      }),
    ).not.toThrow()
  })

  test("rejects malformed or unsafe plan quota configuration", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_MONGOLGPT_PLAN_LIMITS: JSON.stringify({
              ...planLimits,
              free: {
                ...planLimits.free,
                dailyRequestsFallback: 0,
              },
            }),
          },
        }),
      ["MONGOLGPT_PLAN_LIMITS", "dailyRequestsFallback"],
    )

    const { monthlyRequestLimit: _missingMonthlyRequestLimit, ...unsafeBasic } = planLimits.plans.basic
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_MONGOLGPT_PLAN_LIMITS: JSON.stringify({
              ...planLimits,
              plans: { ...planLimits.plans, basic: unsafeBasic },
            }),
          },
        }),
      ["MONGOLGPT_PLAN_LIMITS", "monthlyRequestLimit"],
    )

    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_MONGOLGPT_PLAN_LIMITS: "{",
          },
        }),
      ["MONGOLGPT_PLAN_LIMITS", "JSON"],
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
            SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify({
              models: {
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
              lightweightModels: {},
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
      [
        "үйлчилгээ үзүүлэгчийн чиглэл",
        '"primary" үйлчилгээ үзүүлэгч бодит API түлхүүр',
        '"primary" үйлчилгээ үзүүлэгч бодит API төгсгөлийн цэг',
      ],
    )
  })

  test("rejects placeholder credentials used only by a non-Free-Auto route", () => {
    const models = JSON.parse(hosted.SST_SECRET_MONGOLGPT_GATEWAY_MODELS1)
    models.lightweightModels.assistant = {
      name: "Assistant",
      cost: { input: 0, output: 0 },
      maxTokensPerRequest: 32_000,
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
            SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify(models),
          },
        }),
      [
        "lightweightModels.assistant",
        '"sample" үйлчилгээ үзүүлэгч бодит API түлхүүр',
        '"sample" үйлчилгээ үзүүлэгч бодит API төгсгөлийн цэг',
      ],
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
            SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify({
              ...JSON.parse(hosted.SST_SECRET_MONGOLGPT_GATEWAY_MODELS1),
              models: {
                "free-auto": {
                  ...JSON.parse(hosted.SST_SECRET_MONGOLGPT_GATEWAY_MODELS1).models["free-auto"],
                  rateLimit: undefined,
                },
              },
            }),
          },
        }),
      ["ажиллах орчны загварын схем", "хүсэлтийн хязгаарыг"],
    )
  })

  test("blocks NVIDIA API Catalog trial routes from production", () => {
    const models = JSON.parse(hosted.SST_SECRET_MONGOLGPT_GATEWAY_MODELS1)
    models.providers.nvidia.productionUseApproved = false

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
            SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify(models),
          },
        }),
      ["NVIDIA API Catalog", "productionUseApproved=true"],
    )

    expect(
      preflightDeployment({
        stage: "dev",
        env: {
          ...cloudflare,
          ...hosted,
          MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
          MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify(models),
        },
      }).stage,
    ).toBe("dev")
  })

  test("blocks silent Free Auto provider filtering and an inverted production route", () => {
    const models = JSON.parse(hosted.SST_SECRET_MONGOLGPT_GATEWAY_MODELS1)
    models.providers.openrouter.productionUseApproved = false
    models.providers.openrouter.usageMode = "trial"
    models.providers.openrouter.providerKind = "nvidia-nim"
    models.providers.nvidia.providerKind = "openrouter"

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
            SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify(models),
          },
        }),
      [
        '"openrouter" үйлчилгээ үзүүлэгчийг productionUseApproved=true',
        '"openrouter" үйлчилгээ үзүүлэгчийг usageMode=managed',
        'үндсэн үйлчилгээ үзүүлэгч "openrouter"-ийг providerKind=openrouter',
        'нөөц үйлчилгээ үзүүлэгч "nvidia"-ийг providerKind=nvidia-nim',
      ],
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
