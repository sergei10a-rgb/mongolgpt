import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

test("queue deployment is manual, serialized and guarded before its fixed-target update", async () => {
  const source = await Bun.file(
    new URL("../../../.github/workflows/deploy-dev-usage-queue.yml", import.meta.url),
  ).text()
  const workflow = Bun.YAML.parse(source) as {
    on: { workflow_dispatch: { inputs: { confirmation: { required: boolean } } } }
    permissions: unknown
    concurrency: unknown
    env: Record<string, string>
    jobs: { deploy: { if: string; environment: string; steps: Array<{ name: string; run?: string }> } }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.on.workflow_dispatch.inputs.confirmation.required).toBe(true)
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.jobs.deploy.environment).toBe("dev")
  expect(workflow.jobs.deploy.if).toBe(
    "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
  )
  expect(workflow.env.MONGOLGPT_ENABLE_REAL_PAYMENTS).toBe("false")
  expect(workflow.env.MONGOLGPT_ENABLE_ADMIN).toBe("false")
  const commands = workflow.jobs.deploy.steps.map((step) => step.run ?? "").join("\n")
  expect(commands).toContain('"$DEPLOY_CONFIRMATION" != "DEPLOY DEV USAGE QUEUE"')
  expect(commands).toContain('"$CLOUDFLARE_ACCOUNT_ID" != "cc97ad90bfaf8a1da5de612eef2658f5"')
  expect(commands).toContain('targets="UsageQueueSubscriber,UsageQueueHeartbeatHandler"')
  expect(commands.match(/bun sst (?:diff|deploy)[^\n]*/g)).toEqual([
    'bun sst diff --stage=dev --target "$targets" --json --print-logs >"$diff_file" 2>"$stderr_file"; then',
    'bun sst deploy --stage=dev --target "$targets" --print-logs >"$stdout_file" 2>"$stderr_file"; then',
  ])
  expect(commands.indexOf("verify-usage-queue-deployment.ts")).toBeLessThan(commands.indexOf("bun sst deploy"))
  expect(commands.indexOf('started_at="')).toBeLessThan(commands.indexOf("bun sst deploy"))
  expect(commands.indexOf("check-dev-usage-queue.ts")).toBeGreaterThan(commands.indexOf("bun sst deploy"))
  expect(commands).toContain("umask 077")
  expect(commands).toContain("trap 'rm -f")
  expect(commands).not.toMatch(/sst (?:remove|refresh|unlock|state)|--decrypt|db:migrate|wrangler|curl|cat /)
  expect(source).not.toContain("upload-artifact")
})

test("actual guard CLI never prints malformed private diff data", async () => {
  const root = await mkdtemp(join(tmpdir(), "mongolgpt-queue-guard-"))
  const file = join(root, "diff.json")
  const script = resolve(import.meta.dir, "../../../script/verify-usage-queue-deployment.ts")
  try {
    for (const value of ["[]", '{"private-token":"unterminated', '[{"private-token":"private-value"}]']) {
      await Bun.write(file, value)
      const child = Bun.spawn([process.execPath, script, file], { stdout: "pipe", stderr: "pipe" })
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      const status = await child.exited
      expect(stdout + stderr).not.toContain("private-token")
      expect(stdout + stderr).not.toContain("private-value")
      if (value === "[]") {
        expect(status).toBe(0)
        expect(JSON.parse(stdout)).toMatchObject({ workerUpdates: 0, urlUpdates: 0 })
        continue
      }
      expect(status).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("private diff content was not printed")
    }
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(root))
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("fixture escaped temp root")
    await rm(root, { recursive: true, force: true })
  }
})

test("live-check CLI rejects invalid timestamps without disclosing credentials", async () => {
  const script = resolve(import.meta.dir, "../../../script/check-dev-usage-queue.ts")
  const child = Bun.spawn([process.execPath, script, "not-a-timestamp"], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "private-cli-token" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).not.toContain("private-cli-token")
  expect(stderr).toContain("credentials and response bodies were not printed")
})
