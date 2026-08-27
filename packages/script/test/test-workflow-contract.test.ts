import { describe, expect, test } from "bun:test"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stepsFor(job: unknown) {
  if (!record(job) || !Array.isArray(job.steps)) throw new Error("Workflow job steps are missing")
  return job.steps.filter(record)
}

describe("test workflow contract", () => {
  test("only E2E dependency installation skips native lifecycle scripts", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)

    expect(record(parsed)).toBe(true)
    if (!record(parsed) || !record(parsed.jobs)) return

    const unitSetup = stepsFor(parsed.jobs.unit).find((step) => step.name === "Setup Bun")
    const e2eSetup = stepsFor(parsed.jobs.e2e).find((step) => step.name === "Setup Bun")

    expect(unitSetup?.uses).toBe("./.github/actions/setup-bun")
    expect(unitSetup?.with).toBeUndefined()
    expect(e2eSetup?.uses).toBe("./.github/actions/setup-bun")
    expect(e2eSetup?.with).toEqual({ "install-flags": "--ignore-scripts" })
  })

  test("keeps the setup action install-flags API wired to bun install", async () => {
    const source = await Bun.file(new URL("../../../.github/actions/setup-bun/action.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)

    expect(record(parsed)).toBe(true)
    if (!record(parsed) || !record(parsed.inputs)) return

    expect(record(parsed.inputs["install-flags"])).toBe(true)
    expect(source).toContain("bun install --linker hoisted ${{ inputs.install-flags }}")
    expect(source).toContain("bun install ${{ inputs.install-flags }}")
  })
})
