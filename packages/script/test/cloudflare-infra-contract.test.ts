import { describe, expect, test } from "bun:test"
import { businessIntegrationSecretNames, quotaServiceMigrations } from "../../../infra/console-policy"
import { hostedSstSecretNames } from "../src/deployment"

type WorkflowStep = {
  name?: string
  env?: Record<string, string>
  run?: string
}

type Workflow = {
  jobs: {
    deploy: {
      steps: WorkflowStep[]
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseWorkflow(source: string): Workflow {
  const parsed: unknown = Bun.YAML.parse(source)
  if (!record(parsed) || !record(parsed.jobs) || !record(parsed.jobs.deploy)) {
    throw new Error("Deploy workflow jobs are missing")
  }

  const rawSteps = parsed.jobs.deploy.steps
  if (!Array.isArray(rawSteps)) throw new Error("Deploy workflow steps are missing")

  const steps = rawSteps.map((rawStep): WorkflowStep => {
    if (!record(rawStep)) throw new Error("Deploy workflow contains an invalid step")
    const env: Record<string, string> = {}
    if (record(rawStep.env)) {
      for (const [name, value] of Object.entries(rawStep.env)) {
        if (typeof value === "string") env[name] = value
      }
    }
    return {
      name: typeof rawStep.name === "string" ? rawStep.name : undefined,
      run: typeof rawStep.run === "string" ? rawStep.run : undefined,
      env,
    }
  })

  return { jobs: { deploy: { steps } } }
}

describe("Cloudflare hosted infrastructure contract", () => {
  test("keeps the complete ordered QuotaLedger SQLite migration history", () => {
    expect(quotaServiceMigrations).toEqual([
      {
        tag: "v1",
        newSqliteClasses: ["QuotaLedger"],
      },
    ])
  })

  test("does not create business integration secrets when the feature is disabled", () => {
    expect(businessIntegrationSecretNames(false)).toEqual([])
    expect(businessIntegrationSecretNames(true)).toEqual([
      "DISCORD_INCIDENT_WEBHOOK_URL",
      "AWS_SES_ACCESS_KEY_ID",
      "AWS_SES_SECRET_ACCESS_KEY",
    ])
  })

  test("does not bind legacy Stripe credentials to the hosted console", async () => {
    const sources = await Promise.all(
      ["../../../infra/console.ts", "../../../sst-env.d.ts"].map((path) =>
        Bun.file(new URL(path, import.meta.url)).text(),
      ),
    )
    const legacyBindings = [
      "STRIPE_SECRET_KEY",
      "STRIPE_PUBLISHABLE_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "VITE_STRIPE_PUBLISHABLE_KEY",
    ]

    for (const source of sources) {
      for (const binding of legacyBindings) expect(source).not.toContain(binding)
    }
  })

  test("syncs every hosted credential into the SST stage before deployment", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")
    expect(deployStep).toBeDefined()

    const env = deployStep?.env ?? {}
    for (const name of hostedSstSecretNames) {
      expect(env).toHaveProperty(`SST_SECRET_${name}`)
    }
    expect(env).toHaveProperty(
      "CLOUDFLARE_ACCESS_API_TOKEN",
      "${{ inputs.admin && secrets.CLOUDFLARE_ACCESS_API_TOKEN || '' }}",
    )

    const run = deployStep?.run ?? ""
    const preflight = run.indexOf("deploy:preflight")
    const secretSync = run.indexOf('printf \'%s\' "$value" | bun sst secret set "$name" --stage="$stage"')
    const deploy = run.indexOf("bun sst deploy")
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(secretSync).toBeGreaterThan(preflight)
    expect(deploy).toBeGreaterThan(secretSync)
  })

  test("keeps SST deployment credentials scoped to the deploy step", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const exposed = workflow.jobs.deploy.steps.filter((step) =>
      Object.keys(step.env ?? {}).some(
        (name) => name.startsWith("SST_SECRET_") || name === "CLOUDFLARE_ACCESS_API_TOKEN",
      ),
    )
    expect(exposed.map((step) => step.name)).toEqual(["Validate and deploy to Cloudflare"])
  })

  test("deploys the authenticated Sandbox runtime before publishing the hosted app", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")
    expect(deployStep).toBeDefined()
    expect(deployStep?.env).toHaveProperty("MONGOLGPT_RUNTIME_SECRET")

    const run = deployStep?.run ?? ""
    const sst = run.indexOf("bun sst deploy")
    const binary = run.indexOf("packages/mongolgpt build --single")
    const copy = run.indexOf("cp packages/mongolgpt/dist/mongolgpt-linux-x64/bin/mongolgpt")
    const secrets = run.indexOf("MONGOLGPT_RUNTIME_SECRET: process.env.MONGOLGPT_RUNTIME_SECRET")
    const runtime = run.indexOf("wrangler deploy")
    expect(binary).toBeGreaterThanOrEqual(0)
    expect(copy).toBeGreaterThan(binary)
    expect(secrets).toBeGreaterThan(copy)
    expect(runtime).toBeGreaterThan(secrets)
    expect(sst).toBeGreaterThan(runtime)
    expect(run).toContain('--secrets-file="$runtime_secrets"')
  })

  test("migrates D1 before publishing schema-dependent hosted services", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")
    expect(deployStep).toBeDefined()

    const run = deployStep?.run ?? ""
    const database = run.indexOf("bun sst deploy --stage=${{ inputs.stage }} --target Database --print-logs")
    const migration = run.indexOf("bun sst shell --stage=${{ inputs.stage }} -- bun run db:migrate")
    const application = run.lastIndexOf("bun sst deploy --stage=${{ inputs.stage }} --print-logs")
    expect(database).toBeGreaterThanOrEqual(0)
    expect(migration).toBeGreaterThan(database)
    expect(application).toBeGreaterThan(migration)
  })

  test("runs bounded account deletion retention against the linked D1 database", async () => {
    const source = await Bun.file(new URL("../../../infra/console.ts", import.meta.url)).text()
    expect(source).toContain('new sst.cloudflare.Cron("AccountDeletionRetention"')
    expect(source).toContain('schedules: ["*/15 * * * *"]')
    expect(source).toContain('handler: "packages/console/function/src/account-deletion.ts"')
    expect(source).toContain("link: [database]")
  })

  test("creates a fail-closed Cloudflare Access admin application through IaC", async () => {
    const [adminSource, stageSource, configSource, accessSource, mfaScriptSource] = await Promise.all(
      [
        "../../../infra/admin.ts",
        "../../../infra/stage.ts",
        "../../../sst.config.ts",
        "../../console/admin/src/lib/access.ts",
        "../../../script/cloudflare-access-mfa.ts",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    )
    expect(adminSource).toContain('new sst.cloudflare.x.SolidStart("Admin"')
    expect(adminSource).toContain('path: "packages/console/admin"')
    expect(adminSource).toContain("database")
    expect(adminSource).toContain('new cloudflare.Provider("AdminAccessProvider"')
    expect(adminSource).toContain("CLOUDFLARE_ACCESS_API_TOKEN")
    expect(adminSource).toContain("new cloudflare.ZeroTrustAccessApplication")
    expect(adminSource).toContain('"command:local:Command"')
    expect(adminSource).toContain("bun run script/cloudflare-access-mfa.ts")
    expect(adminSource).toContain("additionalSecretOutputs")
    expect(adminSource).toContain("dependsOn: [accessOrganizationMfa]")
    expect(adminSource).toContain('type: "self_hosted"')
    expect(adminSource).toContain('decision: "allow"')
    expect(adminSource).toContain("parseBootstrapEmails(value).map")
    expect(adminSource).toContain('allowedAuthenticators: ["totp", "biometrics", "security_key"]')
    expect(adminSource).toContain("mfaDisabled: false")
    expect(adminSource).toContain("optionsPreflightBypass: false")
    expect(adminSource).toContain("enableBindingCookie: true")
    expect(adminSource).toContain("httpOnlyCookieAttribute: true")
    expect(adminSource).toContain('sameSiteCookieAttribute: "strict"')
    expect(adminSource).toContain('new sst.Linkable("AdminAccessConfig"')
    expect(adminSource).toContain("link: [database, accessConfig, bootstrapEmails]")
    expect(adminSource).toContain("MongolGPTAdminBootstrapEmails")
    expect(adminSource).not.toContain("MongolGPTAdminAccessTeamDomain")
    expect(adminSource).not.toContain("MongolGPTAdminAccessAudience")
    expect(adminSource).not.toMatch(/\beveryone\s*:/)
    expect(adminSource).not.toMatch(/decision:\s*["']bypass["']/)
    expect(accessSource).toContain('readResourceProperty("AdminAccessConfig", "teamDomain")')
    expect(accessSource).toContain('readResourceProperty("AdminAccessConfig", "audience")')
    expect(stageSource).toContain("enableAdmin")
    expect(stageSource).toContain("adminOrigin")
    expect(configSource).toContain('flag("MONGOLGPT_ENABLE_ADMIN")')
    expect(configSource).toContain('admin ? { command: "1.0.1" }')
    expect(configSource).toContain('await import("./infra/admin.js")')
    expect(configSource).toContain("Production hosted launch requires MONGOLGPT_ENABLE_ADMIN=true.")
    expect(configSource).not.toContain("MONGOLGPT_ADMIN_MFA_ENFORCED")
    expect(mfaScriptSource).toContain("configureCloudflareAccessMfa")
    expect(mfaScriptSource).not.toContain("CLOUDFLARE_API_TOKEN")
  })
})
