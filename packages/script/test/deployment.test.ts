import { describe, expect, test } from "bun:test"
import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "../src/deployment"
import { inspectDeploymentStage, requireDeploymentStage } from "../src/deployment-stage"
import { buildDevFreeAutoCatalog } from "../src/dev-free-auto"

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
  MONGOLGPT_MONITOR_ALERT_EMAIL: "ops@example.com",
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
          { id: "mongolgpt-base-free", model: "mimo-v2.5-free", priority: 0 },
          { id: "openrouter", model: "openrouter/auto", priority: 1 },
          { id: "nvidia", model: "nvidia/auto", priority: 2 },
        ],
      },
    },
    lightweightModels: {},
    providers: {
      "mongolgpt-base-free": {
        api: "https://opencode.ai/zen/v1",
        apiKey: "public",
        providerKind: "mongolgpt-base-free",
        usageMode: "managed",
        productionUseApproved: true,
      },
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
      MONGOLGPT_MONITOR_ALERT_EMAIL: hosted.MONGOLGPT_MONITOR_ALERT_EMAIL,
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

  test("requires a verified operator email for production monitoring alerts", () => {
    const base = {
      ...cloudflare,
      ...hosted,
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_ENABLE_ADMIN: "true",
      CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
      SST_SECRET_MongolGPTAdminBootstrapEmails: "admin@mgpt.mn",
      MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
    }
    expectIssues(
      () => preflightDeployment({ stage: "production", env: { ...base, MONGOLGPT_MONITOR_ALERT_EMAIL: "" } }),
      ["MONGOLGPT_MONITOR_ALERT_EMAIL дутуу"],
    )
    expectIssues(
      () => preflightDeployment({ stage: "production", env: { ...base, MONGOLGPT_MONITOR_ALERT_EMAIL: "not-email" } }),
      ["MONGOLGPT_MONITOR_ALERT_EMAIL хүчинтэй"],
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

  test("allows GitHub-only dev OAuth bootstrap without a model catalog", () => {
    const {
      MONGOLGPT_RUNTIME_SECRET: _runtimeSecret,
      SST_SECRET_GOOGLE_CLIENT_ID: _google,
      SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: _models,
      ...githubOnly
    } = hosted

    const result = preflightDeployment({
      stage: "dev",
      scope: "auth-bootstrap",
      env: {
        ...cloudflare,
        ...githubOnly,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
      },
    })

    expect(result.stage).toBe("dev")
  })

  test("validates auth bootstrap configuration without requiring Cloudflare credentials", () => {
    const {
      MONGOLGPT_RUNTIME_SECRET: _runtimeSecret,
      SST_SECRET_GOOGLE_CLIENT_ID: _google,
      SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: _models,
      ...githubOnly
    } = hosted

    const result = preflightDeployment({
      stage: "dev",
      scope: "auth-bootstrap",
      requireCloudflareCredentials: false,
      env: {
        MONGOLGPT_DOMAIN: cloudflare.MONGOLGPT_DOMAIN,
        ...githubOnly,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
      },
    })

    expect(result.stage).toBe("dev")
  })

  test("allows Google-only dev OAuth bootstrap without GitHub credentials", () => {
    const {
      MONGOLGPT_RUNTIME_SECRET: _runtimeSecret,
      SST_SECRET_GITHUB_CLIENT_ID_CONSOLE: _githubID,
      SST_SECRET_GITHUB_CLIENT_SECRET_CONSOLE: _githubSecret,
      SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: _models,
      ...googleOnly
    } = hosted

    const result = preflightDeployment({
      stage: "dev",
      scope: "auth-bootstrap",
      env: {
        ...cloudflare,
        ...googleOnly,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
      },
    })

    expect(result.stage).toBe("dev")
  })

  test("keeps the model catalog mandatory for a full dev deploy", () => {
    const { SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: _models, ...withoutModels } = hosted
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...withoutModels,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          },
        }),
      ["MONGOLGPT_GATEWAY_MODELS1"],
    )
  })

  test("rejects auth bootstrap outside dev", () => {
    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          scope: "auth-bootstrap",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_PRODUCTION_CONFIRMATION: "DEPLOY mgpt.mn",
          },
        }),
      ["зөвхөн dev"],
    )
  })

  test("allows docs-only preflight only for static dev infrastructure", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: { ...cloudflare, MONGOLGPT_DEPLOY_DOCS_ONLY: "true" },
      requireHostedServices: false,
      scope: "docs-only",
    })
    expect(result.hostedServices).toBe(false)
    expect(deploymentEndpoints(result).docs).toBe("https://docs.dev.mgpt.mn/docs")

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: { ...cloudflare, MONGOLGPT_DEPLOY_DOCS_ONLY: "true" },
          requireHostedServices: false,
          scope: "docs-only",
        }),
      ["Docs-only scope-ийг зөвхөн dev"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_DEPLOY_DOCS_ONLY: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "smoke@mgpt.mn",
          },
          requireDeploymentSecrets: false,
          scope: "docs-only",
        }),
      ["MONGOLGPT_ENABLE_HOSTED_SERVICES=false"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: { ...cloudflare, MONGOLGPT_DEPLOY_DOCS_ONLY: "true" },
        }),
      ["зөвхөн docs-only scope"],
    )
  })

  test("allows app-only preflight only for the hosted dev Worker", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_DEPLOY_APP_ONLY: "true",
      },
      requireDeploymentSecrets: false,
      requireHostedServices: true,
      scope: "app-only",
    })
    expect(result.hostedServices).toBe(true)
    expect(deploymentEndpoints(result).app).toBe("https://app.dev.mgpt.mn")
    expect(result.warnings).toContain("Зөвхөн hosted web app Worker deploy хийнэ; backend resource өөрчлөхгүй.")

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_DEPLOY_APP_ONLY: "true",
          },
          requireDeploymentSecrets: false,
          scope: "app-only",
        }),
      ["App-only scope-ийг зөвхөн dev"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: { ...cloudflare, MONGOLGPT_DEPLOY_APP_ONLY: "true" },
          requireDeploymentSecrets: false,
          scope: "app-only",
        }),
      ["MONGOLGPT_ENABLE_HOSTED_SERVICES=true"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_DEPLOY_APP_ONLY: "true",
            MONGOLGPT_ENABLE_MONITORING: "true",
          },
          requireDeploymentSecrets: false,
          scope: "app-only",
        }),
      ["MONGOLGPT_ENABLE_MONITORING нь app-only deploy үед false"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_DEPLOY_APP_ONLY: "true",
          },
          requireDeploymentSecrets: false,
        }),
      ["зөвхөн app-only scope"],
    )
  })

  test("allows console-only preflight only for the public dev console and OAuth service", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        ...hosted,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
        MONGOLGPT_ENABLE_D1_BACKUPS: "false",
        MONGOLGPT_ENABLE_MONITORING: "false",
        MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true",
        MONGOLGPT_ENABLE_ROOT_PREVIEW_ALIAS: "true",
      },
      requireDeploymentSecrets: false,
      requireHostedServices: true,
      scope: "console-only",
    })
    expect(result.hostedServices).toBe(true)
    expect(result.scope).toBe("console-only")
    expect(deploymentEndpoints(result)).toEqual({
      docs: "https://docs.dev.mgpt.mn/docs",
      app: "https://app.dev.mgpt.mn",
      console: "https://dev.mgpt.mn",
      consoleHealth: "https://dev.mgpt.mn/api/health",
      authHealth: "https://auth.dev.mgpt.mn/health",
      runtimeHealth: "https://runtime.dev.mgpt.mn/global/health",
      paymentHealth: "https://pay.dev.mgpt.mn/health",
    })
    expect(result.warnings).toContain(
      "Зөвхөн Console болон AuthApi target deploy хийнэ; route ownership хадгалж runtime, database, payments, docs болон admin target-уудыг шууд deploy хийхгүй.",
    )

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: { ...cloudflare, MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true" },
          requireDeploymentSecrets: false,
          scope: "console-only",
        }),
      ["Console-only scope-ийг зөвхөн dev"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "false",
            MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true",
          },
          requireDeploymentSecrets: false,
          scope: "console-only",
        }),
      ["MONGOLGPT_ENABLE_HOSTED_SERVICES=true"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: { ...cloudflare, MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true" },
          requireDeploymentSecrets: false,
        }),
      ["зөвхөн console-only scope"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_RUNTIME_SECRET: "",
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            MONGOLGPT_ENABLE_D1_BACKUPS: "false",
            MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true",
            MONGOLGPT_RUNTIME_AUTH_SECRET: hosted.MONGOLGPT_RUNTIME_AUTH_SECRET,
            MONGOLGPT_ENABLE_MONITORING: "true",
          },
          requireDeploymentSecrets: false,
          scope: "console-only",
        }),
      ["MONGOLGPT_ENABLE_MONITORING нь console-only deploy үед false"],
    )
    expect(() =>
      preflightDeployment({
        stage: "dev",
        env: {
          ...cloudflare,
          ...hosted,
          MONGOLGPT_RUNTIME_SECRET: "",
          MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
          MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          MONGOLGPT_ENABLE_D1_BACKUPS: "false",
          MONGOLGPT_ENABLE_MONITORING: "false",
          MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true",
          MONGOLGPT_RUNTIME_AUTH_SECRET: hosted.MONGOLGPT_RUNTIME_AUTH_SECRET,
        },
        scope: "console-only",
      }),
    ).not.toThrow()
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_RUNTIME_SECRET: "",
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            MONGOLGPT_ENABLE_D1_BACKUPS: "false",
            MONGOLGPT_ENABLE_MONITORING: "false",
            MONGOLGPT_DEPLOY_CONSOLE_ONLY: "true",
            MONGOLGPT_RUNTIME_AUTH_SECRET: "",
          },
          scope: "console-only",
        }),
      ["MONGOLGPT_RUNTIME_AUTH_SECRET"],
    )
  })

  test("allows admin-only preflight only for the isolated dev admin Access boundary", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_ENABLE_ADMIN: "true",
        MONGOLGPT_ENABLE_D1_BACKUPS: "false",
        MONGOLGPT_ENABLE_MONITORING: "false",
        MONGOLGPT_ENABLE_TURNSTILE: "false",
        MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
        CLOUDFLARE_ACCESS_API_TOKEN: "access-token",
        MONGOLGPT_RUNTIME_AUTH_SECRET: hosted.MONGOLGPT_RUNTIME_AUTH_SECRET,
        SST_SECRET_ByokCredentialsKeyV1: hosted.SST_SECRET_ByokCredentialsKeyV1,
        SST_SECRET_MONGOLGPT_PLAN_LIMITS: hosted.SST_SECRET_MONGOLGPT_PLAN_LIMITS,
        SST_SECRET_MongolGPTRuntimeAuthSecret: hosted.SST_SECRET_MongolGPTRuntimeAuthSecret,
        SST_SECRET_MongolGPTAdminBootstrapEmails: "admin@mgpt.mn",
      },
      requireHostedServices: true,
      scope: "admin-only",
    })
    expect(result.hostedServices).toBe(true)
    expect(result.scope).toBe("admin-only")
    expect(result.adminEnabled).toBe(true)
    expect(deploymentEndpoints(result)).toEqual({
      docs: "https://docs.dev.mgpt.mn/docs",
      app: "https://app.dev.mgpt.mn",
      console: "https://dev.mgpt.mn",
      consoleHealth: "https://dev.mgpt.mn/api/health",
      authHealth: "https://auth.dev.mgpt.mn/health",
      runtimeHealth: "https://runtime.dev.mgpt.mn/global/health",
      paymentHealth: "https://pay.dev.mgpt.mn/health",
      admin: "https://admin.dev.mgpt.mn",
    })
    expect(result.warnings).toContain(
      "Dev graph-ийн diff-ийг зөвхөн Admin болон Access өөрчлөлтөөр хязгаарласны дараа admin app-ийг bootstrap хийнэ.",
    )

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: { ...cloudflare, MONGOLGPT_DEPLOY_ADMIN_ONLY: "true" },
          requireDeploymentSecrets: false,
          scope: "admin-only",
        }),
      ["Admin-only scope-ийг зөвхөн dev"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "false",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
          },
          requireDeploymentSecrets: false,
          scope: "admin-only",
        }),
      ["MONGOLGPT_ENABLE_HOSTED_SERVICES=true"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "false",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
          },
          requireDeploymentSecrets: false,
          scope: "admin-only",
        }),
      ["MONGOLGPT_ENABLE_ADMIN=true"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
            MONGOLGPT_ENABLE_MONITORING: "true",
          },
          requireDeploymentSecrets: false,
          scope: "admin-only",
        }),
      ["MONGOLGPT_ENABLE_MONITORING нь admin-only deploy үед false"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
            MONGOLGPT_PAYMENT_ENVIRONMENT: "sandbox",
          },
          requireDeploymentSecrets: false,
          scope: "admin-only",
        }),
      ["MONGOLGPT_PAYMENT_ENVIRONMENT нь admin-only deploy үед disabled байна."],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
          },
          requireDeploymentSecrets: false,
        }),
      ["зөвхөн admin-only scope"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
            MONGOLGPT_RUNTIME_AUTH_SECRET: "",
            SST_SECRET_MongolGPTRuntimeAuthSecret: "",
          },
          scope: "admin-only",
        }),
      ["MONGOLGPT_RUNTIME_AUTH_SECRET", "SST_SECRET_MongolGPTRuntimeAuthSecret"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_ADMIN: "true",
            MONGOLGPT_DEPLOY_ADMIN_ONLY: "true",
            MONGOLGPT_RUNTIME_AUTH_SECRET: hosted.MONGOLGPT_RUNTIME_AUTH_SECRET,
            SST_SECRET_ByokCredentialsKeyV1: hosted.SST_SECRET_ByokCredentialsKeyV1,
            SST_SECRET_MONGOLGPT_PLAN_LIMITS: hosted.SST_SECRET_MONGOLGPT_PLAN_LIMITS,
            SST_SECRET_MongolGPTRuntimeAuthSecret: hosted.SST_SECRET_MongolGPTRuntimeAuthSecret,
          },
          scope: "admin-only",
        }),
      ["CLOUDFLARE_ACCESS_API_TOKEN", "MongolGPTAdminBootstrapEmails"],
    )
  })

  test("allows d1-backup-only preflight only for isolated dev backup automation", () => {
    const result = preflightDeployment({
      stage: "dev",
      env: {
        ...cloudflare,
        MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
        MONGOLGPT_ENABLE_D1_BACKUPS: "true",
        MONGOLGPT_DEPLOY_D1_BACKUP_ONLY: "true",
        SST_SECRET_D1BackupApiToken: "dev-d1-backup-token",
      },
      scope: "d1-backup-only",
    })
    expect(result.scope).toBe("d1-backup-only")
    expect(result.backupsEnabled).toBe(true)
    expect(result.warnings).toContain(
      "Зөвхөн dev D1 backup bucket, retention, Workflow болон Cron target-уудыг deploy хийнэ.",
    )

    expectIssues(
      () =>
        preflightDeployment({
          stage: "production",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_ENABLE_D1_BACKUPS: "true",
            MONGOLGPT_DEPLOY_D1_BACKUP_ONLY: "true",
            SST_SECRET_D1BackupApiToken: "dev-d1-backup-token",
          },
          scope: "d1-backup-only",
        }),
      ["зөвхөн dev"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_DEPLOY_D1_BACKUP_ONLY: "true",
          },
          scope: "d1-backup-only",
        }),
      ["MONGOLGPT_ENABLE_D1_BACKUPS=true", "D1_BACKUP_API_TOKEN"],
    )
  })

  test("allows runtime-only preflight with only the isolated dev runtime secrets", () => {
    const runtime = {
      ...cloudflare,
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_RUNTIME_SECRET: hosted.MONGOLGPT_RUNTIME_SECRET,
      MONGOLGPT_RUNTIME_AUTH_SECRET: hosted.MONGOLGPT_RUNTIME_AUTH_SECRET,
    }
    const result = preflightDeployment({
      stage: "dev",
      env: runtime,
      requireHostedServices: true,
      scope: "runtime-only",
    })
    expect(result.hostedServices).toBe(true)
    expect(deploymentEndpoints(result).runtimeHealth).toBe("https://runtime.dev.mgpt.mn/global/health")
    expect(result.warnings).toContain("Зөвхөн dev runtime Worker болон Cloudflare Sandbox container deploy хийнэ.")

    expectIssues(
      () => preflightDeployment({ stage: "production", env: runtime, scope: "runtime-only" }),
      ["Runtime-only scope-ийг зөвхөн dev"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: { ...runtime, MONGOLGPT_RUNTIME_AUTH_SECRET: "" },
          scope: "runtime-only",
        }),
      ["MONGOLGPT_RUNTIME_AUTH_SECRET"],
    )
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: { ...runtime, MONGOLGPT_ENABLE_MONITORING: "true" },
          scope: "runtime-only",
        }),
      ["MONGOLGPT_ENABLE_MONITORING нь runtime-only deploy үед false"],
    )
  })

  test("rejects retired gateway secrets without canonical replacements", () => {
    const {
      SST_SECRET_MONGOLGPT_GATEWAY_SESSION_SECRET: sessionSecret,
      SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: modelConfig,
      ...withoutCanonicalGatewaySecrets
    } = hosted

    expectIssues(
      () =>
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
      ["MONGOLGPT_GATEWAY_SESSION_SECRET", "MONGOLGPT_GATEWAY_MODELS1"],
    )
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
                    { id: "primary", model: "your-model-id", priority: 0 },
                    { id: "fallback", model: "fallback-model", priority: 1 },
                  ],
                },
              },
              lightweightModels: {},
              providers: {
                primary: {
                  api: "https://api.example.invalid/v1",
                  apiKey: "your-api-key",
                  providerKind: "mongolgpt-base-free",
                  usageMode: "managed",
                },
                fallback: {
                  api: "https://fallback.test/v1",
                  apiKey: "sample-api-key",
                  providerKind: "nvidia-nim",
                  usageMode: "managed",
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

  test("accepts sentinel credentials only for account-owned BYOK routes", () => {
    const catalog = buildDevFreeAutoCatalog({
      openRouterApiKey: "real-openrouter-managed-key",
      nvidiaNimApiKey: "real-nvidia-managed-key",
    })
    expect(
      preflightDeployment({
        stage: "dev",
        env: {
          ...cloudflare,
          ...hosted,
          MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
          MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
          SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify(catalog),
        },
      }).stage,
    ).toBe("dev")

    const unsafe = structuredClone(catalog)
    unsafe.providers.openrouter.usageMode = "managed"
    expectIssues(
      () =>
        preflightDeployment({
          stage: "dev",
          env: {
            ...cloudflare,
            ...hosted,
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_AUTH_EMAIL_DOMAINS: "team@mgpt.mn",
            SST_SECRET_MONGOLGPT_GATEWAY_MODELS1: JSON.stringify(unsafe),
          },
        }),
      ["ажиллах орчны загварын схем", "usageMode=byok"],
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
        "эцсийн нөөц чиглэл providerKind=nvidia-nim",
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
