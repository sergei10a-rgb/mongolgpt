import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const CHECKOUT_PINS = new Map([
  ["de0fac2e4500dabe0009e67214ff5f5447ce83dd", "v6.0.2"],
  ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"],
])
const CACHE_PINS = new Map([["55cc8345863c7cc4c66a329aec7e433d2d1c52a9", "v6.1.0"]])
const SETUP_NODE_PINS = new Map([["820762786026740c76f36085b0efc47a31fe5020", "v7.0.0"]])
const UPLOAD_ARTIFACT_PINS = new Map([["043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "v7.0.1"]])
const DOWNLOAD_ARTIFACT_PINS = new Map([["3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8.0.1"]])
const ACTION_PINS: Record<string, Map<string, string>> = {
  "actions/checkout": CHECKOUT_PINS,
  "actions/cache": CACHE_PINS,
  "actions/cache/restore": CACHE_PINS,
  "actions/cache/save": CACHE_PINS,
  "actions/setup-node": SETUP_NODE_PINS,
  "actions/upload-artifact": UPLOAD_ARTIFACT_PINS,
  "actions/download-artifact": DOWNLOAD_ARTIFACT_PINS,
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stepsFor(job: unknown) {
  if (!record(job) || !Array.isArray(job.steps)) throw new Error("Workflow job steps are missing")
  return job.steps.filter(record)
}

describe("test workflow contract", () => {
  test("cancels stale suites for the same branch or pull request", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)

    expect(record(parsed)).toBe(true)
    if (!record(parsed) || !record(parsed.concurrency)) return

    expect(parsed.concurrency["cancel-in-progress"]).toBe(true)
    expect(parsed.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    )
    expect(source).not.toContain("github.run_id")
  })

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

  test("packages and exercises the Windows desktop in the default CI suite", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)

    expect(record(parsed)).toBe(true)
    if (!record(parsed) || !record(parsed.jobs)) return

    const job = parsed.jobs["desktop-smoke"]
    expect(record(job)).toBe(true)
    if (!record(job)) return
    expect(job["runs-on"]).toBe("windows-2025")
    expect(job["timeout-minutes"]).toBe(45)
    expect(job.env).toEqual({ MONGOLGPT_CHANNEL: "dev" })

    const steps = stepsFor(job)
    const setup = steps.find((step) => step.name === "Setup Bun")
    const prepare = steps.findIndex((step) => step.name === "Prepare desktop bundle")
    const version = steps.findIndex((step) => step.name === "Read prepared desktop version")
    const build = steps.findIndex((step) => step.name === "Build desktop")
    const packaged = steps.findIndex((step) => step.name === "Package unsigned dev installer")
    const smoke = steps.find((step) => step.name === "Smoke packaged MongolGPT Dev")
    const upload = steps.find((step) => step.name === "Upload desktop smoke artifacts")

    expect(setup?.uses).toBe("./.github/actions/setup-bun")
    expect(setup?.with).toBeUndefined()
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(version)
    expect(version).toBeLessThan(build)
    expect(build).toBeLessThan(packaged)
    expect(smoke?.shell).toBe("pwsh")
    expect(smoke?.run).toContain("./scripts/smoke-packaged-windows.ps1")
    expect(smoke?.run).toContain('-ExpectedVersion "${{ steps.desktop-version.outputs.version }}"')
    expect(smoke?.run).toContain('-ExpectedProductName "MongolGPT Dev"')
    expect(smoke?.run).toContain("-UseExternalPtyProbe")
    expect(upload?.if).toBe("failure()")
    expect(JSON.stringify(upload)).toContain("mongolgpt-desktop-smoke.json.png")
  })

  test("keeps the setup action install-flags API wired to bun install", async () => {
    const source = await Bun.file(new URL("../../../.github/actions/setup-bun/action.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)

    expect(record(parsed)).toBe(true)
    if (!record(parsed) || !record(parsed.inputs)) return

    expect(record(parsed.inputs["install-flags"])).toBe(true)
    expect(source).toContain("bun install --linker hoisted ${{ inputs.install-flags }}")
    expect(source).toContain("bun install ${{ inputs.install-flags }}")
    expect(source).toContain("if ! bun install --linker hoisted ${{ inputs.install-flags }}; then")
    expect(source).toContain("Windows Bun install failed; retrying once after a short delay")
  })

  test("keeps core JavaScript actions on approved Node 24 pins", async () => {
    const root = fileURLToPath(new URL("../../../.github/", import.meta.url))
    const glob = new Bun.Glob("**/*.{yml,yaml}")
    const references: Array<{ action: string; sha: string; version: string | undefined; file: string }> = []

    for await (const file of glob.scan({ cwd: root })) {
      const source = await Bun.file(`${root}/${file}`).text()
      for (const match of source.matchAll(
        /^\s*-?\s*uses:\s*(actions\/(?:checkout|setup-node|upload-artifact|download-artifact|cache(?:\/(?:restore|save))?))@([^\s#]+)(?:\s+#\s*(\S+))?\s*$/gm,
      )) {
        references.push({ action: match[1], sha: match[2], version: match[3], file })
      }
    }

    expect(references.length).toBeGreaterThan(0)
    for (const reference of references) {
      const pins = ACTION_PINS[reference.action]
      expect(pins, `${reference.file}: ${reference.action}`).toBeDefined()
      if (!pins) continue
      expect(pins.get(reference.sha), `${reference.file}: ${reference.action}`).toBe(reference.version)
    }
  })
})
