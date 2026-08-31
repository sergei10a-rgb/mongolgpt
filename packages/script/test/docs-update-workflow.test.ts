import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")

describe("scheduled docs update workflow", () => {
  test("skips cleanly until its key and exact immutable CLI asset exist", () => {
    const source = readFileSync(resolve(root, ".github/workflows/docs-update.yml"), "utf8")
    const parsed: unknown = Bun.YAML.parse(source)
    const workflow = record(parsed) ? parsed : {}
    const env = record(workflow.env) ? workflow.env : {}
    const jobs = record(workflow.jobs) ? workflow.jobs : {}
    const job = record(jobs["update-docs"]) ? jobs["update-docs"] : {}
    const steps = Array.isArray(job.steps) ? job.steps.filter(record) : []
    const readiness = steps.find((step) => step.id === "readiness")
    const run = steps.find((step) => step.name === "MongolGPT ажиллуулах")

    expect(env.MONGOLGPT_CLI_VERSION).toBe("0.1.2")
    expect(readiness?.if).toBe("steps.commits.outputs.has_commits == 'true'")
    expect(readiness?.run).toContain('if [ -z "${MONGOLGPT_API_KEY:-}" ]')
    expect(readiness?.run).toContain('tag="mongolgpt-v${MONGOLGPT_CLI_VERSION}"')
    expect(readiness?.run).toContain('asset="mongolgpt-${target}.tar.gz"')
    expect(readiness?.run).toContain("jq -e --arg asset")
    expect(readiness?.run).toContain('echo "ready=true" >> "$GITHUB_OUTPUT"')
    expect(run?.if).toBe("steps.commits.outputs.has_commits == 'true' && steps.readiness.outputs.ready == 'true'")
    expect(run?.with).toMatchObject({ cli_version: "${{ env.MONGOLGPT_CLI_VERSION }}" })
    expect(source).not.toContain("releases/latest")
  })
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
