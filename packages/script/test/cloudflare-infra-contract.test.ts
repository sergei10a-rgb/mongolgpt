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

  test("syncs every hosted credential into the SST stage before deployment", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/deploy.yml", import.meta.url)).text()
    const workflow = parseWorkflow(source)
    const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate and deploy to Cloudflare")
    expect(deployStep).toBeDefined()

    const env = deployStep?.env ?? {}
    for (const name of hostedSstSecretNames) {
      expect(env).toHaveProperty(`SST_SECRET_${name}`)
    }

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
      Object.keys(step.env ?? {}).some((name) => name.startsWith("SST_SECRET_")),
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
})
