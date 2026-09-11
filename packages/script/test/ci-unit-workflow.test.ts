import { expect, test } from "bun:test"

type Step = {
  name: string
  id?: string
  uses?: string
  with?: Record<string, string>
  if?: string
  run?: string
  "timeout-minutes"?: number | string
  "continue-on-error"?: boolean
  env?: Record<string, string>
}

test("Windows CLI and other unit suites keep separate bounded sequential steps without dropping Linux coverage", async () => {
  const source = await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as {
    jobs: {
      unit: {
        strategy: {
          matrix: {
            settings: { name: string; test_filter: string; test_concurrency: string; timeout_minutes: number }[]
          }
        }
        steps: Step[]
      }
    }
  }
  const job = workflow.jobs.unit
  const windows = job.strategy.matrix.settings.find((entry) => entry.name === "windows")!
  const linux = job.strategy.matrix.settings.find((entry) => entry.name === "linux")!
  expect(windows.test_filter).toBe("--filter=!mongolgpt")
  expect(windows.test_concurrency).toBe("--concurrency=1")
  expect(windows.timeout_minutes).toBe(30)
  expect(linux.test_filter).toBe("")
  expect(linux.test_concurrency).toBe("")
  expect(linux.timeout_minutes).toBe(20)

  const common = job.steps.find((step) => step.name === "Run unit tests")!
  const cli = job.steps.find((step) => step.name === "Run Windows CLI unit tests")!
  expect(common.run).toBe(
    "GITHUB_ACTIONS=false bun turbo test ${{ matrix.settings.test_concurrency }} ${{ matrix.settings.test_filter }} --log-order=stream",
  )
  expect(cli.run).toBe("GITHUB_ACTIONS=false bun turbo test --filter=mongolgpt --concurrency=1 --log-order=stream")
  expect(job.steps.indexOf(cli)).toBe(job.steps.indexOf(common) + 1)
  expect(common.if).toBeUndefined()
  expect(cli.if).toBe("runner.os == 'Windows'")
  expect(common["timeout-minutes"]).toBe("${{ matrix.settings.timeout_minutes }}")
  expect(cli["timeout-minutes"]).toBe(30)
  expect(common["continue-on-error"]).not.toBe(true)
  expect(cli["continue-on-error"]).not.toBe(true)
  expect(cli.env?.MONGOLGPT_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe("true")
  expect(common.env?.MONGOLGPT_EXPERIMENTAL_DISABLE_FILEWATCHER).toBe(
    "${{ runner.os == 'Windows' && 'true' || 'false' }}",
  )
  const container = job.steps.find((step) => step.name === "Verify compiled hosted container persistence")!
  const sandbox = job.steps.find((step) => step.name === "Build and test authenticated Sandbox control plane")!
  expect(container.if).toBe("runner.os == 'Linux'")
  expect(container["timeout-minutes"]).toBe(12)
  expect(container["continue-on-error"]).not.toBe(true)
  expect(job.steps.indexOf(container)).toBeGreaterThan(job.steps.indexOf(sandbox))
  expect(container.run).toContain("MONGOLGPT_VERSION=0.0.0-ci-container MONGOLGPT_CHANNEL=dev")
  expect(container.run).toContain("script/build.ts --single --skip-install --skip-embed-web-ui")
  expect(container.run).toContain('sudo -- env MONGOLGPT_TEST_NODE="$(command -v node)" "$(command -v bun)"')
  expect(container.run).toContain("packages/runtime/script/test-hosted-container.ts")
  expect(sandbox.if).toBe("runner.os == 'Linux'")
  expect(sandbox["timeout-minutes"]).toBe(5)
  expect(sandbox["continue-on-error"]).not.toBe(true)
  expect(sandbox.run).toContain(
    'sudo -- env MONGOLGPT_TEST_NODE="$(command -v node)" "$(command -v bun)" packages/runtime/script/test-sandbox-control.ts',
  )
})

test("Turbo cache reuses a pre-test hash without traversing root-private evidence during post-save", async () => {
  const source = await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as { jobs: { unit: { steps: Step[] } } }
  const steps = workflow.jobs.unit.steps
  const fingerprint = steps.find((step) => step.id === "turbo-cache-key")
  const cache = steps.find((step) => step.name === "Cache Turbo")!
  expect(fingerprint).toBeDefined()
  expect(fingerprint?.env?.TURBO_INPUTS_HASH).toBe("${{ hashFiles('turbo.json', '**/package.json') }}")
  expect(fingerprint?.run).toBe('echo "hash=$TURBO_INPUTS_HASH" >> "$GITHUB_OUTPUT"')
  expect(fingerprint?.if).toBeUndefined()
  expect(fingerprint?.["continue-on-error"]).not.toBe(true)
  expect(steps.indexOf(fingerprint!)).toBeLessThan(steps.indexOf(cache))
  expect(steps.indexOf(cache)).toBeLessThan(steps.findIndex((step) => step.name === "Run unit tests"))
  expect(cache.with?.key).toBe("turbo-${{ runner.os }}-${{ steps.turbo-cache-key.outputs.hash }}-${{ github.sha }}")
  expect(cache.with?.["restore-keys"]?.trim().split("\n")).toEqual([
    "turbo-${{ runner.os }}-${{ steps.turbo-cache-key.outputs.hash }}-",
    "turbo-${{ runner.os }}-",
  ])
  expect(JSON.stringify(cache)).not.toContain("hashFiles(")
  expect(cache["continue-on-error"]).not.toBe(true)
})

test("real workerd framing runs early on both platforms without replacing the compiled persistence gate", async () => {
  const source = await Bun.file(new URL("../../../.github/workflows/test.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as { jobs: { unit: { steps: Step[] } } }
  const steps = workflow.jobs.unit.steps
  const probe = steps.find((step) => step.name === "Verify real workerd bridge request framing")!
  expect(probe).toBeDefined()
  expect(probe.if).toBeUndefined()
  expect(probe["continue-on-error"]).not.toBe(true)
  expect(probe["timeout-minutes"]).toBe(2)
  expect(probe.run).toBe(
    "node --experimental-strip-types packages/runtime/test/fixtures/container-checkpoint-bridge.ts --tcp-startup-only",
  )
  expect(steps.indexOf(probe)).toBeGreaterThan(steps.findIndex((step) => step.name === "Setup Bun"))
  expect(steps.indexOf(probe)).toBeLessThan(steps.findIndex((step) => step.name === "Run unit tests"))
  expect(steps.filter((step) => step.run?.includes("--tcp-startup-only"))).toHaveLength(1)
  expect(steps.find((step) => step.name === "Verify compiled hosted container persistence")?.run).toContain(
    "packages/runtime/script/test-hosted-container.ts",
  )
})
