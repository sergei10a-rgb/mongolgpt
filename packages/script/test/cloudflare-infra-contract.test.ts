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
  test("checks the repository Cloudflare token without deploying resources", async () => {
    const source = await Bun.file(
      new URL("../../../.github/workflows/cloudflare-preflight.yml", import.meta.url),
    ).text()
    const parsed: unknown = Bun.YAML.parse(source)
    if (!record(parsed) || !record(parsed.on) || !record(parsed.jobs) || !record(parsed.jobs.verify)) {
      throw new Error("Cloudflare token preflight workflow is invalid")
    }
    const job = parseWorkflowJob(parsed.jobs.verify, "verify")
    const check = job.steps.find((step) => step.name === "Verify Cloudflare deploy token without changing resources")

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"])
    expect(job.condition).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
    expect(check?.run).toBe("bun run cloudflare:preflight")
    expect(check?.env).toEqual({
      MONGOLGPT_DOMAIN: "${{ vars.MONGOLGPT_DOMAIN }}",
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: "${{ vars.CLOUDFLARE_DEFAULT_ACCOUNT_ID }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    })
    expect(source).not.toContain("environment:")
    expect(source).not.toContain("sst deploy")
    expect(source).not.toContain("wrangler deploy")
    expect(source).not.toContain("GITHUB_CLIENT_SECRET_CONSOLE")
    expect(source).not.toContain("MONGOLGPT_GATEWAY_MODELS")
  })

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
    const configPreflight = job.steps.find((step) => step.name === "Verify dev OAuth bootstrap configuration")
    const tokenPreflight = job.steps.find((step) => step.name === "Verify Cloudflare OAuth bootstrap token")
    const contracts = job.steps.find((step) => step.name === "Verify bootstrap contracts")
    const deploy = job.steps.find((step) => step.name === "Bootstrap real dev OAuth infrastructure")
    const smoke = job.steps.find((step) => step.name === "Verify dev account scaffold")

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"])
    expect(rawJob.environment).toBe("dev")
    expect(job.condition).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
    expect(confirmation?.env).toEqual({ BOOTSTRAP_CONFIRMATION: "${{ inputs.confirmation }}" })
    expect(confirmation?.run).toContain('if [ "$BOOTSTRAP_CONFIRMATION" != "BOOTSTRAP DEV AUTH dev.mgpt.mn" ]; then')
    expect(confirmation?.run).not.toContain("${{ inputs.confirmation }}")
    expect(configPreflight?.env).toEqual({
      MONGOLGPT_RUNTIME_AUTH_SECRET: "${{ secrets.MONGOLGPT_RUNTIME_AUTH_SECRET }}",
      SST_SECRET_ByokCredentialsKeyV1: "${{ secrets.BYOK_CREDENTIALS_KEY_V1 }}",
      SST_SECRET_GITHUB_CLIENT_ID_CONSOLE: "${{ vars.MONGOLGPT_GITHUB_OAUTH_CLIENT_ID }}",
      SST_SECRET_GITHUB_CLIENT_SECRET_CONSOLE: "${{ secrets.MONGOLGPT_GITHUB_OAUTH_CLIENT_SECRET }}",
      SST_SECRET_GOOGLE_CLIENT_ID: "${{ vars.GOOGLE_CLIENT_ID }}",
      SST_SECRET_MONGOLGPT_PLAN_LIMITS: "${{ secrets.MONGOLGPT_PLAN_LIMITS }}",
      SST_SECRET_MongolGPTRuntimeAuthSecret: "${{ secrets.MONGOLGPT_RUNTIME_AUTH_SECRET }}",
      SST_SECRET_TurnstileSecretKey: "1x0000000000000000000000000000000AA",
      SST_SECRET_MONGOLGPT_GATEWAY_SESSION_SECRET: "${{ secrets.MONGOLGPT_GATEWAY_SESSION_SECRET }}",
    })
    expect(configPreflight?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN")
    expect(configPreflight?.run).toBe("bun run deploy:preflight -- dev --auth-bootstrap --config-only")
    expect(tokenPreflight?.env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" })
    expect(tokenPreflight?.run).toBe("bun script/cloudflare-preflight.ts --auth-bootstrap")
    expect(job.steps.indexOf(configPreflight!)).toBeLessThan(job.steps.indexOf(tokenPreflight!))
    expect(job.steps.indexOf(tokenPreflight!)).toBeLessThan(job.steps.indexOf(contracts!))

    expect(source).not.toContain("production")
    expect(source).not.toContain("MONGOLGPT_SMOKE_AUTH_COOKIE")
    expect(source).not.toContain("deploy:smoke")
    expect(source).not.toContain("wrangler deploy")
    expect(source).not.toContain("packages/runtime")
    expect(source).not.toContain("MONGOLGPT_RUNTIME_SECRET")
    expect(source).toContain('MONGOLGPT_ENABLE_ADMIN: "false"')
    expect(source).toContain('MONGOLGPT_ENABLE_REAL_PAYMENTS: "false"')
    expect(source).toContain("MONGOLGPT_PAYMENT_ENVIRONMENT: disabled")
    expect(source).toContain("deploy:preflight -- dev --auth-bootstrap")
    expect(source).toContain("set_optional_secret GITHUB_CLIENT_ID_CONSOLE")
    expect(source).toContain("set_optional_secret GITHUB_CLIENT_SECRET_CONSOLE")
    expect(source).toContain("set_optional_secret GOOGLE_CLIENT_ID")
    expect(source).not.toMatch(/\$\{\{\s*(?:vars|secrets)\.GITHUB_/)
    expect(source).not.toContain("SST_SECRET_MONGOLGPT_GATEWAY_MODELS1")
    expect(source).not.toMatch(/QPAY_|BONUM_|CLOUDFLARE_ACCESS_API_TOKEN|MONGOLGPT_ADMIN_BOOTSTRAP_EMAILS/)
    expect(contracts?.run).toContain("bun test --cwd packages/console/app")
    expect(contracts?.run).not.toContain("bun --cwd packages/console/app test")
    expect(deploy?.run).not.toContain("deploy:preflight")

    const run = deploy?.run ?? ""
    const oauthSecrets = run.indexOf("set_optional_secret GOOGLE_CLIENT_ID")
    const refresh = run.indexOf('bun sst refresh --stage="$stage" --print-logs')
    const database = run.indexOf('bun sst deploy --stage="$stage" --target Database')
    const migration = run.indexOf('bun sst shell --stage="$stage" -- bun run db:migrate')
    const oauth = run.indexOf('bun sst deploy --stage="$stage" --target AuthApi --target Console --print-logs')
    expect(oauthSecrets).toBeGreaterThanOrEqual(0)
    expect(refresh).toBeGreaterThan(oauthSecrets)
    expect(database).toBeGreaterThan(refresh)
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
      VITE_MONGOLGPT_RELEASE_SHA: "${{ github.sha }}",
      VITE_MONGOLGPT_SERVER_URL: "${{ steps.service-urls.outputs.runtime_url }}",
    })
    const serviceUrls = workflow.jobs.verify.steps.find((step) => step.name === "Resolve hosted service URLs")
    expect(serviceUrls?.run).toBe('bun script/deployment-service-urls.ts "${{ inputs.stage }}"')
    expect(source).not.toContain("format('https://app.{0}'")
    expect(source).not.toContain("format('https://runtime.{0}'")
    expect(buildStep?.run).toContain("bun --cwd packages/app verify:hosted-artifact")
    const webApp = await Bun.file(new URL("../../../infra/web-app.ts", import.meta.url)).text()
    expect(webApp).toContain('new sst.cloudflare.StaticSiteV2("WebApp"')
    expect(webApp).toContain('command: "bun run build:hosted"')
    expect(webApp).toContain("VITE_MONGOLGPT_SERVER_URL: runtimeOrigin")
    expect(webApp).toContain('VITE_MONGOLGPT_RELEASE_SHA: process.env.MONGOLGPT_RELEASE_SHA ?? ""')
    expect(webApp).toContain('args.handler = "packages/app/cloudflare-router.ts"')
    expect(webApp).toContain("const supportUrl = `${publicOrigin}/support`")
    expect(webApp).not.toContain("github.com/sergei10a-rgb/mongolgpt/issues")
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
    expect(steps[browser]?.env?.PLAYWRIGHT_DEPLOYED_RELEASE_SHA).toBe("${{ github.sha }}")
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
    expect(consoleSource).toContain('new sst.Secret("GITHUB_CLIENT_ID_CONSOLE", "")')
    expect(consoleSource).toContain('new sst.Secret("GITHUB_CLIENT_SECRET_CONSOLE", "")')
    expect(consoleSource).toContain('new sst.Secret("GOOGLE_CLIENT_ID", "")')
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

  test("builds and verifies the exact static docs artifact before deploy", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const build = workflow.jobs.verify.steps.find((step) => step.name === "Build docs")?.run ?? ""

    expect(build).toContain("MONGOLGPT_STATIC_DOCS=true bun run build:docs")
    expect(build).toContain("bun run --cwd packages/web verify:static-artifact")
  })

  test("deploys dev docs independently without account, model, or payment secrets", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy-dev-docs.yml", import.meta.url)).text()
    const sstSource = await Bun.file(new URL("../../../sst.config.ts", import.meta.url)).text()
    const docsSource = await Bun.file(new URL("../../../infra/docs.ts", import.meta.url)).text()
    const siteSource = await Bun.file(new URL("../../../infra/site.ts", import.meta.url)).text()
    const webAppSource = await Bun.file(new URL("../../../infra/web-app.ts", import.meta.url)).text()
    const rootPackage: unknown = await Bun.file(new URL("../../../package.json", import.meta.url)).json()
    const parsed: unknown = Bun.YAML.parse(source)
    if (!record(parsed) || !record(parsed.jobs) || !record(rootPackage) || !record(rootPackage.dependencies)) {
      throw new Error("Dev docs workflow or root package dependencies are missing")
    }
    const job = parseWorkflowJob(parsed.jobs.deploy, "deploy")
    const deploy = job.steps.find((step) => step.name === "Deploy only dev docs to Cloudflare")
    const smoke = job.steps.find((step) => step.name === "Verify live dev docs")

    expect(source).toContain("workflow_dispatch:")
    expect(source).not.toMatch(/^\s+push:/m)
    expect(source).toContain("environment: dev")
    expect(source).toContain('MONGOLGPT_ENABLE_HOSTED_SERVICES: "false"')
    expect(source).toContain("MONGOLGPT_PUBLIC_URL: https://docs.dev.mgpt.mn")
    expect(source).toContain("MONGOLGPT_CONSOLE_URL: https://dev.mgpt.mn")
    expect(source).toContain("MONGOLGPT_SUPPORT_URL: https://dev.mgpt.mn/support")
    expect(source).toContain('MONGOLGPT_DEPLOY_DOCS_ONLY: "true"')
    expect(record(parsed.env) ? parsed.env.MONGOLGPT_DEPLOY_DOCS_ONLY : undefined).toBeUndefined()
    expect(deploy?.env?.MONGOLGPT_DEPLOY_DOCS_ONLY).toBe("true")
    expect(smoke?.env?.MONGOLGPT_DEPLOY_DOCS_ONLY).toBe("true")
    expect(source).toContain("DEPLOY DEV DOCS docs.dev.mgpt.mn")
    expect(source).toContain("MONGOLGPT_STATIC_DOCS=true bun run build:docs")
    expect(source).toContain("bun run --cwd packages/web verify:static-artifact")
    expect(source).toContain("bun run deploy:preflight -- dev --docs-only")
    expect(source).toContain("bun sst deploy --stage=dev --target Website --print-logs")
    expect(source).toContain("bun script/deployment-smoke.ts --docs-only dev")
    expect(source).not.toContain("--target WebApp")
    expect(source).not.toMatch(/MONGOLGPT_(?:GATEWAY|RUNTIME|SMOKE_AUTH)|QPAY_|BONUM_|GITHUB_CLIENT|GOOGLE_CLIENT/)
    expect(rootPackage.dependencies["@mongolgpt/account-contract"]).toBe("workspace:*")
    expect(sstSource).toContain("if (docsOnly) {")
    expect(sstSource).toContain('await import("./infra/docs.js")')
    expect(sstSource.indexOf("if (docsOnly) {")).toBeLessThan(sstSource.indexOf('await import("./infra/site.js")'))
    expect(docsSource).toContain('new sst.cloudflare.StaticSiteV2("Website"')
    expect(docsSource).not.toContain('StaticSiteV2("WebApp"')
    expect(docsSource).toContain("const docsSiteOrigin = new URL(docsOrigin).origin")
    expect(docsSource).toContain("MONGOLGPT_PUBLIC_URL: docsSiteOrigin")
    expect(siteSource).toContain('export { webApp } from "./web-app"')
    expect(webAppSource).toContain('new sst.cloudflare.StaticSiteV2("WebApp"')
    expect(webAppSource).toContain('args.handler = "packages/app/cloudflare-router.ts"')
    expect(webAppSource).toContain("transform: {")
  })

  test("deploys only the dev hosted app Worker without backend credentials", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy-dev-app.yml", import.meta.url)).text()
    const sstSource = await Bun.file(new URL("../../../sst.config.ts", import.meta.url)).text()
    const webAppSource = await Bun.file(new URL("../../../infra/web-app.ts", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)
    if (!record(parsed) || !record(parsed.on) || !record(parsed.jobs) || !record(parsed.jobs.deploy)) {
      throw new Error("Dev app-only workflow is invalid")
    }
    const job = parseWorkflowJob(parsed.jobs.deploy, "deploy")
    const confirmation = job.steps.find((step) => step.name === "Validate exact dev app confirmation")
    const deploy = job.steps.find((step) => step.name === "Deploy only dev app to Cloudflare")
    const smoke = job.steps.find((step) => step.name === "Verify live dev app boundary")
    const browser = job.steps.find((step) => step.name === "Verify dev app-only boundary in Chromium")
    const artifacts = job.steps.find((step) => step.name === "Upload app-only browser artifacts")

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"])
    expect(parsed.jobs.deploy.environment).toBe("dev")
    expect(job.condition).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
    expect(confirmation?.env).toEqual({ DEPLOY_CONFIRMATION: "${{ inputs.confirmation }}" })
    expect(confirmation?.run).toContain('if [ "$DEPLOY_CONFIRMATION" != "DEPLOY DEV APP app.dev.mgpt.mn" ]; then')
    expect(source).not.toMatch(/^\s+push:/m)
    expect(source).not.toContain("production")
    expect(source).toContain('MONGOLGPT_ENABLE_HOSTED_SERVICES: "true"')
    expect(source).toContain("VITE_MONGOLGPT_SERVER_URL: https://runtime.dev.mgpt.mn")
    expect(record(parsed.env) ? parsed.env.MONGOLGPT_DEPLOY_APP_ONLY : undefined).toBeUndefined()
    expect(deploy?.env?.MONGOLGPT_DEPLOY_APP_ONLY).toBe("true")
    expect(smoke?.env?.MONGOLGPT_DEPLOY_APP_ONLY).toBe("true")
    expect(deploy?.run).toContain("bun run deploy:preflight -- dev --app-only")
    expect(deploy?.run).toContain("bun sst deploy --stage=dev --target WebApp --print-logs")
    expect(smoke?.run).toBe("bun script/deployment-smoke.ts --app-only dev")
    expect(browser?.env).toEqual({
      CI: "true",
      PLAYWRIGHT_DEPLOYED_BASE_URL: "https://app.dev.mgpt.mn",
      PLAYWRIGHT_DEPLOYED_PUBLIC_URL: "https://dev.mgpt.mn",
      PLAYWRIGHT_DEPLOYED_RUNTIME_URL: "https://runtime.dev.mgpt.mn",
      PLAYWRIGHT_DEPLOYED_RELEASE_SHA: "${{ github.sha }}",
      PLAYWRIGHT_DEPLOYED_CHANNEL: "dev",
    })
    expect(browser?.run).toBe("bun --cwd packages/app test:e2e:deployed:app-only")
    expect(job.steps.indexOf(browser!)).toBeGreaterThan(job.steps.indexOf(smoke!))
    expect(artifacts?.condition).toBe("always()")
    expect(artifacts?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(artifacts?.with?.path).toContain("packages/app/e2e/test-results-deployed")
    expect(artifacts?.with?.path).toContain("packages/app/e2e/playwright-report-deployed")
    expect(source).not.toMatch(
      /MONGOLGPT_(?:GATEWAY|RUNTIME_SECRET|SMOKE_AUTH)|QPAY_|BONUM_|GITHUB_CLIENT|GOOGLE_CLIENT/,
    )
    expect(source).not.toContain("--target Database")
    expect(source).not.toContain("--target Website")
    expect(sstSource).toContain('const appOnly = flag("MONGOLGPT_DEPLOY_APP_ONLY")')
    expect(sstSource).toContain("if (appOnly) {")
    expect(sstSource).toContain('const site = await import("./infra/web-app.js")')
    expect(sstSource).toContain("WebAppUrl: site.webApp.url")
    expect(webAppSource).not.toContain('from "./docs"')
    expect(webAppSource).not.toContain('StaticSiteV2("Website"')
  })

  test("deploys only the isolated dev runtime with bounded secrets and live boundary smoke", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy-dev-runtime.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)
    if (!record(parsed) || !record(parsed.on) || !record(parsed.jobs) || !record(parsed.jobs.deploy)) {
      throw new Error("Dev runtime-only workflow is invalid")
    }
    const job = parseWorkflowJob(parsed.jobs.deploy, "deploy")
    const confirmation = job.steps.find((step) => step.name === "Validate exact dev runtime confirmation")
    const tokenPreflight = job.steps.find((step) => step.name === "Verify Cloudflare runtime token")
    const build = job.steps.find((step) => step.name === "Build hosted runtime image payload")
    const deploy = job.steps.find((step) => step.name === "Deploy only dev runtime to Cloudflare")
    const smoke = job.steps.find((step) => step.name === "Verify live dev runtime boundary")
    const browser = job.steps.find((step) => step.name === "Verify dev app and runtime in Chromium")
    const artifacts = job.steps.find((step) => step.name === "Upload deployed browser artifacts")

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"])
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(parsed.jobs.deploy.environment).toBe("dev")
    expect(job.condition).toBe("github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'")
    expect(confirmation?.env).toEqual({ DEPLOY_CONFIRMATION: "${{ inputs.confirmation }}" })
    expect(confirmation?.run).toContain(
      'if [ "$DEPLOY_CONFIRMATION" != "DEPLOY DEV RUNTIME runtime.dev.mgpt.mn" ]; then',
    )
    expect(source).not.toMatch(/^\s+push:/m)
    expect(source).not.toContain("production")
    expect(source).toContain('MONGOLGPT_ENABLE_HOSTED_SERVICES: "true"')
    expect(source).not.toMatch(/MONGOLGPT_(?:GATEWAY|SMOKE_AUTH)|QPAY_|BONUM_|GITHUB_CLIENT|GOOGLE_CLIENT|BYOK_/)

    expect(tokenPreflight?.env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" })
    expect(tokenPreflight?.run).toBe("bun script/cloudflare-preflight.ts --runtime-only")
    expect(job.steps.indexOf(tokenPreflight!)).toBeLessThan(job.steps.indexOf(build!))

    expect(build?.run).toContain("packages/mongolgpt build --single --skip-embed-web-ui --skip-install")
    expect(build?.run).toContain("test -x packages/mongolgpt/dist/mongolgpt-linux-x64/bin/mongolgpt")
    expect(build?.run).toContain("cp packages/mongolgpt/dist/mongolgpt-linux-x64/bin/mongolgpt")
    expect(deploy?.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      MONGOLGPT_RUNTIME_SECRET: "${{ secrets.MONGOLGPT_RUNTIME_SECRET }}",
      MONGOLGPT_RUNTIME_AUTH_SECRET: "${{ secrets.MONGOLGPT_RUNTIME_AUTH_SECRET }}",
    })
    expect(deploy?.run).toContain("bun run deploy:preflight -- dev --runtime-only")
    expect(deploy?.run).toContain("trap 'rm -f \"$runtime_secrets\"' EXIT")
    expect(deploy?.run).toContain('packages/runtime script/deploy.ts dev --secrets-file="$runtime_secrets"')
    expect(deploy?.run).not.toContain("bun sst")
    expect(smoke?.run).toBe("bun script/deployment-smoke.ts --runtime-only dev")
    expect(browser?.env).toEqual({
      CI: "true",
      PLAYWRIGHT_DEPLOYED_BASE_URL: "https://app.dev.mgpt.mn",
      PLAYWRIGHT_DEPLOYED_PUBLIC_URL: "https://dev.mgpt.mn",
      PLAYWRIGHT_DEPLOYED_RUNTIME_URL: "https://runtime.dev.mgpt.mn",
    })
    expect(browser?.run).toBe("bun --cwd packages/app test:e2e:deployed:anonymous")
    expect(job.steps.indexOf(browser!)).toBeGreaterThan(job.steps.indexOf(smoke!))
    expect(artifacts?.condition).toBe("always()")
    expect(artifacts?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
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
