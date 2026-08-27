import { describe, expect, test } from "bun:test"
import {
  businessIntegrationSecretNames,
  D1_BACKUP_MULTIPART_ABORT_SECONDS,
  D1_BACKUP_RETENTION_DAYS,
  D1_BACKUP_RETENTION_SECONDS,
  D1_BACKUP_SCHEDULE,
  quotaServiceMigrations,
} from "../../../infra/console-policy"
import { hostedSstSecretNames } from "../src/deployment"

type WorkflowStep = {
  name?: string
  condition?: string
  env?: Record<string, string>
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  jobs: {
    verify: WorkflowJob
    deploy: WorkflowJob
  }
}

type WorkflowJob = {
  condition?: string
  steps: WorkflowStep[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseWorkflow(source: string): Workflow {
  const parsed: unknown = Bun.YAML.parse(source)
  if (!record(parsed) || !record(parsed.jobs)) {
    throw new Error("Deploy workflow jobs are missing")
  }

  return {
    jobs: {
      verify: parseWorkflowJob(parsed.jobs.verify, "verify"),
      deploy: parseWorkflowJob(parsed.jobs.deploy, "deploy"),
    },
  }
}

function parseWorkflowJob(input: unknown, name: string): WorkflowJob {
  if (!record(input) || !Array.isArray(input.steps)) throw new Error(`Deploy workflow ${name} job is missing`)

  const steps = input.steps.map((rawStep): WorkflowStep => {
    if (!record(rawStep)) throw new Error("Deploy workflow contains an invalid step")
    const env: Record<string, string> = {}
    if (record(rawStep.env)) {
      for (const [name, value] of Object.entries(rawStep.env)) {
        if (typeof value === "string") env[name] = value
      }
    }
    return {
      name: typeof rawStep.name === "string" ? rawStep.name : undefined,
      condition: typeof rawStep.if === "string" ? rawStep.if : undefined,
      run: typeof rawStep.run === "string" ? rawStep.run : undefined,
      uses: typeof rawStep.uses === "string" ? rawStep.uses : undefined,
      with: record(rawStep.with) ? rawStep.with : undefined,
      env,
    }
  })

  return {
    condition: typeof input.if === "string" ? input.if : undefined,
    steps,
  }
}

describe("Cloudflare hosted infrastructure contract", () => {
  test("bootstraps only real dev OAuth before the authenticated deployment gate", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/bootstrap-dev-auth.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)
    if (!record(parsed) || !record(parsed.on) || !record(parsed.jobs)) {
      throw new Error("Dev OAuth bootstrap workflow is invalid")
    }
    const rawJob = parsed.jobs.bootstrap
    if (!record(rawJob)) throw new Error("Dev OAuth bootstrap job is missing")
    const job = parseWorkflowJob(rawJob, "bootstrap")
    const confirmation = job.steps.find((step) => step.name === "Validate exact dev bootstrap confirmation")
    const deploy = job.steps.find((step) => step.name === "Bootstrap real dev OAuth infrastructure")
    const smoke = job.steps.find((step) => step.name === "Verify real dev OAuth bootstrap")

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"])
    expect(rawJob.environment).toBe("dev")
    expect(job.condition).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
    expect(confirmation?.env).toEqual({ BOOTSTRAP_CONFIRMATION: "${{ inputs.confirmation }}" })
    expect(confirmation?.run).toContain('if [ "$BOOTSTRAP_CONFIRMATION" != "BOOTSTRAP DEV AUTH dev.mgpt.mn" ]; then')
    expect(confirmation?.run).not.toContain("${{ inputs.confirmation }}")

    expect(source).not.toContain("production")
    expect(source).not.toContain("MONGOLGPT_SMOKE_AUTH_COOKIE")
    expect(source).not.toContain("deploy:smoke")
    expect(source).not.toContain("wrangler deploy")
    expect(source).toContain('MONGOLGPT_ENABLE_ADMIN: "false"')
    expect(source).toContain('MONGOLGPT_ENABLE_REAL_PAYMENTS: "false"')
    expect(source).toContain("MONGOLGPT_PAYMENT_ENVIRONMENT: disabled")

    const run = deploy?.run ?? ""
    const database = run.indexOf('bun sst deploy --stage="$stage" --target Database')
    const migration = run.indexOf('bun sst shell --stage="$stage" -- bun run db:migrate')
    const oauth = run.indexOf('bun sst deploy --stage="$stage" --target AuthApi --target Console --print-logs')
    expect(database).toBeGreaterThanOrEqual(0)
    expect(migration).toBeGreaterThan(database)
    expect(oauth).toBeGreaterThan(migration)
    expect(smoke?.run).toBe("bun script/deployment-smoke.ts --auth-bootstrap dev")
    expect(job.steps.indexOf(smoke!)).toBeGreaterThan(job.steps.indexOf(deploy!))
  })

  test("rejects non-canonical SST stages before deriving domains or protection", async () => {
    const configSource = await Bun.file(new URL("../../../sst.config.ts", import.meta.url)).text()
    expect(configSource).toContain('await import("./packages/script/src/deployment-stage.js")')
    expect(configSource).toContain("const stage = requireDeploymentStage(input?.stage)")
    expect(configSource).not.toContain('input?.stage === "production"')
  })

  test("never publishes the public web app without hosted services", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const buildStep = workflow.jobs.verify.steps.find((step) => step.name === "Build web app")
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")

    expect(source).toContain('MONGOLGPT_ENABLE_HOSTED_SERVICES: "true"')
    expect(source).toContain("MONGOLGPT_ENABLE_D1_BACKUPS: ${{ inputs.stage == 'production' && 'true' || 'false' }}")
    expect(source).toContain('MONGOLGPT_ENABLE_MONITORING: "true"')
    expect(source).toContain('MONGOLGPT_ENABLE_TURNSTILE: "true"')
    expect(source).toContain("vars.MONGOLGPT_TURNSTILE_SITE_KEY")
    expect(source).toContain("secrets.TURNSTILE_SECRET_KEY")
    expect(source).not.toContain("inputs.hosted_services")
    expect(buildStep?.env).toEqual({
      MONGOLGPT_CHANNEL: "${{ steps.service-urls.outputs.channel }}",
      VITE_MONGOLGPT_APP_URL: "${{ steps.service-urls.outputs.app_url }}",
      VITE_MONGOLGPT_PUBLIC_URL: "${{ steps.service-urls.outputs.public_url }}",
      VITE_MONGOLGPT_SERVER_URL: "${{ steps.service-urls.outputs.runtime_url }}",
    })
    const serviceUrls = workflow.jobs.verify.steps.find((step) => step.name === "Resolve hosted service URLs")
    expect(serviceUrls?.run).toBe('bun script/deployment-service-urls.ts "${{ inputs.stage }}"')
    expect(source).not.toContain("format('https://app.{0}'")
    expect(source).not.toContain("format('https://runtime.{0}'")
    expect(buildStep?.run).toContain("bun --cwd packages/app verify:hosted-artifact")
    const site = await Bun.file(new URL("../../../infra/site.ts", import.meta.url)).text()
    expect(site).toContain('command: "bun run build:hosted"')
    expect(site).toContain("const supportUrl = `${publicOrigin}/support`")
    expect(site).not.toContain("github.com/sergei10a-rgb/mongolgpt/issues")
    expect(workflow.jobs.deploy.condition).toBe(
      "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
    )
    expect(deployStep?.run).toContain('bun --cwd packages/runtime script/deploy.ts "$stage"')
    expect(deployStep?.run).toContain("bun sst deploy --stage=${{ inputs.stage }} --target Database")
  })

  test("gates every deployed app with HTTP and Chromium smoke checks", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const smokeSource = await Bun.file(new URL("../../../script/deployment-smoke.ts", import.meta.url)).text()
    const steps = parseWorkflow(source).jobs.deploy.steps
    const auth = steps.findIndex((step) => step.name === "Validate authenticated smoke identity")
    const deploy = steps.findIndex((step) => step.name === "Validate and deploy to Cloudflare")
    const http = steps.findIndex((step) => step.name === "Verify deployed URLs")
    const browserSetup = steps.findIndex((step) => step.name === "Install Playwright system dependencies")
    const browser = steps.findIndex((step) => step.name === "Verify deployed app in Chromium")
    const artifact = steps.findIndex((step) => step.name === "Upload deployed browser artifacts")

    expect(auth).toBeGreaterThanOrEqual(0)
    expect(deploy).toBeGreaterThan(auth)
    expect(http).toBeGreaterThan(deploy)
    expect(browserSetup).toBeGreaterThan(http)
    expect(browser).toBeGreaterThan(http)
    expect(browser).toBeGreaterThan(browserSetup)
    expect(artifact).toBeGreaterThan(browser)
    expect(steps[auth]?.run).toBe("bun script/deployment-smoke.ts --validate-auth-cookie")
    expect(steps[auth]?.env).toEqual({
      MONGOLGPT_SMOKE_AUTH_COOKIE: "${{ secrets.MONGOLGPT_SMOKE_AUTH_COOKIE }}",
    })
    expect(smokeSource).toContain('model: { providerID: "mongolgpt", modelID: "free-auto" }')
    expect(smokeSource).toContain("MONGOLGPT_SMOKE_READY")
    expect(smokeSource).toContain('method: "DELETE"')
    expect(steps[deploy]?.env?.MONGOLGPT_SMOKE_AUTH_COOKIE).toBeUndefined()
    expect(steps[http]?.env).toEqual({
      MONGOLGPT_SMOKE_AUTH_COOKIE: "${{ secrets.MONGOLGPT_SMOKE_AUTH_COOKIE }}",
    })
    expect(steps[browser]?.run).toBe("bun --cwd packages/app test:e2e:deployed")
    expect(steps[browser]?.env?.MONGOLGPT_SMOKE_AUTH_COOKIE).toBe("${{ secrets.MONGOLGPT_SMOKE_AUTH_COOKIE }}")
    expect(steps[browser]?.env?.PLAYWRIGHT_DEPLOYED_BASE_URL).toBe("${{ needs.verify.outputs.app_url }}")
    expect(steps[browser]?.env?.PLAYWRIGHT_DEPLOYED_PUBLIC_URL).toBe("${{ needs.verify.outputs.public_url }}")
    expect(steps[browser]?.env?.PLAYWRIGHT_DEPLOYED_RUNTIME_URL).toBe("${{ needs.verify.outputs.runtime_url }}")
    expect(steps[artifact]?.condition).toBe("always()")
    expect(steps[artifact]?.uses).toContain("actions/upload-artifact@")
    expect(steps[artifact]?.with?.path).toContain("packages/app/e2e/test-results-deployed")
    expect(steps[artifact]?.with?.path).toContain("packages/app/e2e/playwright-report-deployed")
  })

  test("verifies real sandbox payment adapters without exposing them to production", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const steps = parseWorkflow(source).jobs.deploy.steps
    const http = steps.findIndex((step) => step.name === "Verify deployed URLs")
    const payment = steps.findIndex((step) => step.name === "Verify sandbox payment providers")
    const step = steps[payment]

    expect(payment).toBeGreaterThan(http)
    expect(step?.condition).toBe("inputs.payment_environment == 'sandbox'")
    expect(step?.run).toBe("bun --cwd packages/console/core payment-sandbox-smoke")
    expect(step?.env?.MONGOLGPT_PAYMENT_SANDBOX_CALLBACK_BASE_URL).toBe("${{ needs.verify.outputs.payment_url }}")
    expect(step?.env).toEqual({
      MONGOLGPT_PAYMENT_SANDBOX_SMOKE_CONFIRM: "RUN_SANDBOX_SMOKE",
      MONGOLGPT_PAYMENT_SANDBOX_ENVIRONMENT: "sandbox",
      MONGOLGPT_PAYMENT_SANDBOX_PROVIDER: "all",
      MONGOLGPT_PAYMENT_SANDBOX_CALLBACK_BASE_URL: "${{ needs.verify.outputs.payment_url }}",
      QPAY_MERCHANT_ACCOUNT_ID: "${{ secrets.QPAY_MERCHANT_ACCOUNT_ID }}",
      QPAY_CLIENT_ID: "${{ secrets.QPAY_CLIENT_ID }}",
      QPAY_CLIENT_SECRET: "${{ secrets.QPAY_CLIENT_SECRET }}",
      QPAY_INVOICE_CODE: "${{ secrets.QPAY_INVOICE_CODE }}",
      BONUM_MERCHANT_ACCOUNT_ID: "${{ secrets.BONUM_MERCHANT_ACCOUNT_ID }}",
      BONUM_APP_SECRET: "${{ secrets.BONUM_APP_SECRET }}",
      BONUM_TERMINAL_ID: "${{ secrets.BONUM_TERMINAL_ID }}",
      BONUM_WEBHOOK_CHECKSUM_KEY: "${{ secrets.BONUM_WEBHOOK_CHECKSUM_KEY }}",
    })
  })

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
    expect(businessIntegrationSecretNames(true)).toEqual(["AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY"])
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

  test("keeps the OAuth session host-only without weakening cookie protections", async () => {
    const [consoleSource, authSessionSource] = await Promise.all(
      ["../../../infra/console.ts", "../../console/app/src/context/auth.ts"].map((path) =>
        Bun.file(new URL(path, import.meta.url)).text(),
      ),
    )

    expect(consoleSource).not.toContain("MONGOLGPT_COOKIE_DOMAIN")
    expect(authSessionSource).not.toContain("domain:")
    expect(authSessionSource).toContain('name: import.meta.env.PROD ? "__Host-mongolgpt-auth" : "auth"')
    expect(authSessionSource).toContain("secure: import.meta.env.PROD")
    expect(authSessionSource).toContain("httpOnly: true")
    expect(authSessionSource).toContain('sameSite: "lax"')
    expect(authSessionSource).toContain('path: "/"')
  })

  test("wires one audience-bound capability secret into the console issuer and runtime verifier", async () => {
    const [consoleSource, secretSource, workflowSource] = await Promise.all(
      ["../../../infra/console.ts", "../../../infra/secret.ts", "../../../.github/workflows/deploy.yml"].map((path) =>
        Bun.file(new URL(path, import.meta.url)).text(),
      ),
    )
    const workflow = parseWorkflow(workflowSource)
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")

    expect(consoleSource).toContain("SECRET.MongolGPTRuntimeAuthSecret")
    expect(consoleSource).toContain("MONGOLGPT_RUNTIME_URL: runtimeOrigin")
    expect(secretSource).toContain('new sst.Secret("MongolGPTRuntimeAuthSecret")')
    expect(deployStep?.env).toMatchObject({
      MONGOLGPT_RUNTIME_SECRET: "${{ secrets.MONGOLGPT_RUNTIME_SECRET }}",
      MONGOLGPT_RUNTIME_AUTH_SECRET: "${{ secrets.MONGOLGPT_RUNTIME_AUTH_SECRET }}",
      SST_SECRET_MongolGPTRuntimeAuthSecret: "${{ secrets.MONGOLGPT_RUNTIME_AUTH_SECRET }}",
    })
    expect(deployStep?.run).toContain(
      "MONGOLGPT_RUNTIME_SECRET: process.env.MONGOLGPT_RUNTIME_SECRET, MONGOLGPT_RUNTIME_AUTH_SECRET: process.env.MONGOLGPT_RUNTIME_AUTH_SECRET",
    )
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

  test("uses only canonical MongolGPT gateway secrets", async () => {
    const [consoleSource, authSource, catalogSource, workflowSource] = await Promise.all([
      Bun.file(new URL("../../../infra/console.ts", import.meta.url)).text(),
      Bun.file(new URL("../../console/app/src/context/auth.ts", import.meta.url)).text(),
      Bun.file(new URL("../../console/core/src/model.ts", import.meta.url)).text(),
      Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text(),
    ])

    expect(consoleSource).toContain('new sst.Secret("MONGOLGPT_GATEWAY_SESSION_SECRET", "")')
    expect(consoleSource).not.toContain('new sst.Secret("ZEN_SESSION_SECRET", "")')
    expect(consoleSource).toContain('new sst.Secret("MONGOLGPT_GATEWAY_MODELS1", "")')
    expect(consoleSource).not.toContain('new sst.Secret("ZEN_MODELS1", "")')
    expect(authSource).toContain("password: Resource.MONGOLGPT_GATEWAY_SESSION_SECRET.value")
    expect(authSource).not.toContain("ZEN_SESSION_SECRET")
    expect(catalogSource).not.toContain("ZEN_MODELS")
    expect(workflowSource).toContain("SST_SECRET_MONGOLGPT_GATEWAY_SESSION_SECRET")
    expect(workflowSource).toContain("SST_SECRET_MONGOLGPT_GATEWAY_MODELS1")
    expect(workflowSource).not.toContain("SST_SECRET_ZEN_")
  })

  test("keeps SST configuration free of forbidden top-level imports", async () => {
    const source = await Bun.file(new URL("../../../sst.config.ts", import.meta.url)).text()
    expect(source).not.toMatch(/^import\s/m)
    expect(source).toContain("async app(input)")
    expect(source).toContain('await import("./packages/script/src/deployment-stage.js")')
  })

  test("overwrites stale payment secrets when payment is disabled", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")
    const run = deployStep?.run ?? ""

    expect(run).toContain('payment_environment="${{ inputs.payment_environment }}"')
    expect(run).toContain(
      'if [[ "$name" = QPay* || "$name" = Bonum* ]] && [[ "$payment_environment" = "disabled" ]]; then',
    )
    expect(run).toContain('value="disabled"')
    const disabled = run.indexOf('[[ "$payment_environment" = "disabled" ]]')
    const sentinel = run.indexOf('value="disabled"', disabled)
    const secretSet = run.indexOf('bun sst secret set "$name" --stage="$stage"', sentinel)
    expect(disabled).toBeGreaterThan(-1)
    expect(sentinel).toBeGreaterThan(disabled)
    expect(secretSet).toBeGreaterThan(sentinel)
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
    const runtime = run.indexOf('packages/runtime script/deploy.ts "$stage"')
    expect(binary).toBeGreaterThanOrEqual(0)
    expect(copy).toBeGreaterThan(binary)
    expect(secrets).toBeGreaterThan(copy)
    expect(runtime).toBeGreaterThan(secrets)
    expect(sst).toBeGreaterThan(runtime)
    expect(run).toContain('--secrets-file="$runtime_secrets"')

    const runtimeDeploySource = await Bun.file(new URL("../../runtime/script/deploy.ts", import.meta.url)).text()
    expect(runtimeDeploySource).toContain('new URL("../package.json", import.meta.url)')
    expect(runtimeDeploySource).toContain("resolveHostedServiceUrls(input.rootDomain, input.stage)")
    expect(runtimeDeploySource).toContain("MONGOLGPT_RUNTIME_VERSION:${version}")

    const stageSource = await Bun.file(new URL("../../../infra/stage.ts", import.meta.url)).text()
    expect(stageSource).toContain("resolveHostedServiceUrls(rootDomain, $app.stage)")
    for (const stage of ["dev", "production"]) {
      const config = await Bun.file(new URL(`../../runtime/wrangler.${stage}.jsonc`, import.meta.url)).text()
      expect(config).not.toContain("mgpt.mn")
      expect(config).not.toContain('"routes"')
      expect(config).not.toContain('"vars"')
    }
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

  test("backs up D1 daily to a private, expiring R2 bucket", async () => {
    const [consoleSource, stageSource, configSource, secretSource, workflowSource, scheduleSource] = await Promise.all(
      [
        "../../../infra/console.ts",
        "../../../infra/stage.ts",
        "../../../sst.config.ts",
        "../../../infra/secret.ts",
        "../../console/function/src/d1-backup-workflow.ts",
        "../../console/function/src/d1-backup-schedule.ts",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    )

    expect(D1_BACKUP_SCHEDULE).toBe("20 0 * * *")
    expect(D1_BACKUP_RETENTION_DAYS).toBe(90)
    expect(D1_BACKUP_RETENTION_SECONDS).toBe(7_776_000)
    expect(D1_BACKUP_MULTIPART_ABORT_SECONDS).toBe(86_400)
    expect(consoleSource).toContain('new sst.cloudflare.Bucket("D1Backups")')
    expect(consoleSource).toContain("new cloudflare.R2BucketLifecycle(")
    expect(consoleSource).toContain('conditions: { prefix: "d1/" }')
    expect(consoleSource).toContain("maxAge: D1_BACKUP_RETENTION_SECONDS")
    expect(consoleSource).toContain("maxAge: D1_BACKUP_MULTIPART_ABORT_SECONDS")
    expect(consoleSource).toContain('new sst.cloudflare.Workflow("D1BackupWorkflow"')
    expect(consoleSource).toContain("const d1BackupAutomation = enableD1Backups")
    expect(consoleSource).toContain('className: "D1BackupWorkflow"')
    expect(consoleSource).toContain("link: [d1Backups, SECRET.D1BackupApiToken]")
    expect(consoleSource).toContain('new sst.cloudflare.Cron("D1BackupSchedule"')
    expect(consoleSource).toContain("schedules: [D1_BACKUP_SCHEDULE]")
    expect(consoleSource).not.toContain("public: true")
    expect(secretSource).toContain('D1BackupApiToken: new sst.Secret("D1BackupApiToken")')
    expect(hostedSstSecretNames).toContain("D1BackupApiToken")
    expect(stageSource).toContain('enableD1Backups = process.env.MONGOLGPT_ENABLE_D1_BACKUPS === "true"')
    expect(configSource).toContain("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_D1_BACKUPS=true")
    expect(workflowSource).toContain("startD1Export")
    expect(workflowSource).toContain("storeCompletedD1Export")
    expect(scheduleSource).toContain('successRetention: "30 days"')
    expect(scheduleSource).toContain('errorRetention: "30 days"')
  })

  test("uses Cloudflare Cron and KV for service monitoring without Honeycomb or Discord", async () => {
    const [consoleSource, adminSource, configSource, secretSource, monitorSource] = await Promise.all(
      [
        "../../../infra/console.ts",
        "../../../infra/admin.ts",
        "../../../sst.config.ts",
        "../../../infra/secret.ts",
        "../../console/function/src/service-monitor.ts",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    )

    expect(consoleSource).toContain('new sst.cloudflare.Kv("ServiceMonitorState")')
    expect(consoleSource).toContain('new sst.cloudflare.Cron("ServiceMonitor"')
    expect(consoleSource).toContain('schedules: ["*/5 * * * *"]')
    expect(consoleSource).toContain('handler: "packages/console/function/src/service-monitor.ts"')
    expect(consoleSource).toContain("link: [serviceMonitorState]")
    expect(adminSource).toContain("serviceMonitorState")
    expect(adminSource).toContain("MONGOLGPT_MONITORING_ENABLED")
    expect(configSource).toContain("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_MONITORING=true")
    expect(configSource).not.toContain("honeycomb:")
    expect(configSource).not.toContain('import("./infra/monitoring.js")')
    expect(secretSource).not.toMatch(/Honeycomb|HONEYCOMB/)
    expect(monitorSource).toContain("SERVICE_MONITOR_STATE_KEY")
    expect(monitorSource).toContain("SERVICE_MONITOR_TTL_SECONDS")
    expect(monitorSource).not.toMatch(/Honeycomb|Discord|api[_-]?key|authorization/i)
    expect(await Bun.file(new URL("../../../infra/monitoring.ts", import.meta.url)).exists()).toBe(false)
    expect(await Bun.file(new URL("../../console/app/src/routes/honeycomb/webhook.ts", import.meta.url)).exists()).toBe(
      false,
    )
  })

  test("protects the shared browser OAuth entry with server-verified Cloudflare Turnstile", async () => {
    const [
      consoleSource,
      stageSource,
      deploymentSource,
      routeSource,
      pageSource,
      authSource,
      turnstileSource,
      clientSource,
    ] = await Promise.all(
      [
        "../../../infra/console.ts",
        "../../../infra/stage.ts",
        "../src/deployment.ts",
        "../../console/app/src/routes/auth/authorize.ts",
        "../../console/app/src/routes/auth/turnstile.ts",
        "../../console/function/src/auth.ts",
        "../../console/core/src/turnstile.ts",
        "../../core/src/plugin/provider/mongolgpt.ts",
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
    )

    expect(stageSource).toContain('enableTurnstile = process.env.MONGOLGPT_ENABLE_TURNSTILE === "true"')
    expect(consoleSource).toContain('new sst.Secret("TurnstileSecretKey")')
    expect(consoleSource).toContain("MONGOLGPT_TURNSTILE_SITE_KEY: turnstileSiteKey")
    expect(consoleSource).toContain("TURNSTILE_TEST_SECRET_KEY")
    expect(hostedSstSecretNames).toContain("TurnstileSecretKey")
    expect(deploymentSource).toContain("MONGOLGPT_ENABLE_TURNSTILE=true")
    expect(deploymentSource).toContain("test key-г production орчинд ашиглахгүй")
    expect(routeSource).toContain('"content-security-policy"')
    expect(turnstileSource).toContain("https://challenges.cloudflare.com/turnstile/v0/siteverify")
    expect(turnstileSource).toContain("result.data.action !== TURNSTILE_ACTION")
    expect(turnstileSource).toContain("expectedHostname")
    expect(turnstileSource).not.toMatch(/console\.(?:log|debug)\([^\n]*(?:token|secret)/i)
    expect(consoleSource).toContain("MONGOLGPT_CONSOLE_ORIGIN: publicOrigin")
    expect(routeSource).toContain("renderTurnstileChallenge")
    expect(pageSource).toContain('method="post"')
    expect(authSource).toContain("readTurnstileAuthorizationSubmission")
    expect(authSource).toContain("verifyTurnstile")
    expect(authSource).toContain('error: "turnstile_required"')
    expect(routeSource).toContain('clientID === "mongolgpt-cli"')
    expect(clientSource).toContain("url: authorizeURL(defaultServer, redirect, pkce, state)")
    expect(turnstileSource).toContain('input.submission.clientID === "mongolgpt-cli"')
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
    for (const resource of [
      "database",
      "d1Backups",
      "auth",
      "quotaService",
      "paymentService",
      "usageQueueReadiness",
      "serviceMonitorState",
      "accessConfig",
    ]) {
      expect(adminSource).toContain(`    ${resource},`)
    }
    expect(adminSource).toContain("MONGOLGPT_RUNTIME_URL: runtimeOrigin")
    expect(adminSource).toContain("MONGOLGPT_STAGE: $app.stage")
    expect(adminSource).toContain("SECRET.AdminPaymentCancellationToken")
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
    expect(configSource).toContain("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_ADMIN=true")
    expect(configSource).not.toContain("MONGOLGPT_ADMIN_MFA_ENFORCED")
    expect(mfaScriptSource).toContain("configureCloudflareAccessMfa")
    expect(mfaScriptSource).not.toContain("CLOUDFLARE_API_TOKEN")
  })
})
