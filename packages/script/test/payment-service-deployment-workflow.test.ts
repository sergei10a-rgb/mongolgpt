import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("payment deployment is manually confirmed, disabled, owner/dev-only and guarded before mutation", async () => {
  const source = await Bun.file(
    new URL("../../../.github/workflows/deploy-dev-payment-service.yml", import.meta.url),
  ).text()
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, { inputs: Record<string, { required: boolean; type: string }> }>
    permissions: unknown
    concurrency: unknown
    env: Record<string, string>
    jobs: {
      deploy: {
        if: string
        environment: string
        steps: Array<{ name: string; run?: string; uses?: string; env?: Record<string, string> }>
      }
    }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(workflow.on.workflow_dispatch.inputs.confirmation).toMatchObject({ required: true, type: "string" })
  expect(Object.keys(workflow.jobs)).toEqual(["deploy"])
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.jobs.deploy.environment).toBe("dev")
  expect(workflow.jobs.deploy.if).toBe(
    "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
  )
  expect(workflow.env.MONGOLGPT_DOMAIN).toBe("${{ vars.MONGOLGPT_DOMAIN }}")
  expect(workflow.env.MONGOLGPT_PAYMENT_ENVIRONMENT).toBe("disabled")
  expect(workflow.env.PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW).toBe("true")
  for (const flag of [
    "REAL_PAYMENTS",
    "ADMIN",
    "ANALYTICS",
    "D1_BACKUPS",
    "BUSINESS_INTEGRATIONS",
    "LEGACY_STRIPE",
    "MONITORING",
    "SHARE_SERVICE",
    "SYNC_SERVICE",
    "ROOT_PREVIEW_ALIAS",
  ])
    expect(workflow.env[`MONGOLGPT_ENABLE_${flag}`]).toBe("false")
  const steps = workflow.jobs.deploy.steps
  expect(steps[0].name).toBe("Validate disabled dev confirmation")
  expect(steps[0].env?.DEPLOY_CONFIRMATION).toBe("${{ inputs.confirmation }}")
  expect(steps[0].run).toContain('"$DEPLOY_CONFIRMATION" != "UPDATE DISABLED DEV PAYMENTS"')
  expect(steps[0].run).toContain("exit 1")
  const verification = steps.find((step) => step.name === "Verify payment boundaries and disabled health contract")
  const deploy = steps.find((step) => step.name === "Guard and update only the disabled dev payment worker")
  if (!verification?.run || !deploy?.run) throw new Error("Missing deployment steps")
  expect(steps.indexOf(verification)).toBeLessThan(steps.indexOf(deploy))
  for (const file of [
    "payment-service-deployment-guard",
    "payment-service-live-check",
    "payment-service-deployment-workflow",
    "payment-service-pulumi-args",
    "payment-service-pulumi-launcher",
    "usage-queue-deployment-guard",
    "payment-webhook",
    "service-monitor",
  ])
    expect(verification.run).toContain(`test/${file}.test.ts`)
  const commands = deploy.run
  expect(commands).toContain('"$CLOUDFLARE_ACCOUNT_ID" != "cc97ad90bfaf8a1da5de612eef2658f5"')
  expect(commands).toContain('"$MONGOLGPT_DOMAIN" != "mgpt.mn"')
  expect(commands).toContain("set -euo pipefail")
  expect(commands).toContain("umask 077")
  expect(commands).toContain('trap \'rm -f "$diff_file" "$stdout_file" "$stderr_file" "$adapter_file"\' EXIT')
  const ordered = [
    "exit 1",
    "bun script/check-dev-payment-service.ts before",
    "bun build script/pulumi-dev-payment.ts --compile",
    'export SST_PULUMI_PATH="$adapter_file"',
    "bun sst diff",
    "bun script/verify-payment-service-deployment.ts",
    "bun sst deploy",
    "bun script/check-dev-payment-service.ts after",
  ].map((marker) => commands.indexOf(marker))
  expect(ordered.every((index) => index >= 0)).toBe(true)
  expect(ordered).toEqual([...ordered].sort((left, right) => left - right))
  expect(commands.match(/bun sst [^\n]*/g)).toEqual([
    'bun sst diff --stage=dev --target PaymentServiceScript --target PaymentServiceUrl.sst.cloudflare.WorkerUrl --json --print-logs >"$diff_file" 2>"$stderr_file"; then',
    'bun sst deploy --stage=dev --target PaymentServiceScript --target PaymentServiceUrl.sst.cloudflare.WorkerUrl --print-logs >"$stdout_file" 2>"$stderr_file"; then',
  ])
  expect(commands).not.toMatch(/sst (?:remove|state|refresh|unlock|secret|shell)|--decrypt|curl|wrangler|cat /)
  expect(source).not.toMatch(/continue-on-error|upload-artifact|REAL_PAYMENT_CONFIRMATION|secrets\.(?:QPAY|BONUM)/)
  const audit = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/audit-dev-payment-service.yml", import.meta.url)).text(),
  ) as { env: Record<string, string>; jobs: { audit: { steps: Array<{ env?: Record<string, string> }> } } }
  expect(workflow.env).toEqual(audit.env)
  expect(deploy.env).toEqual(audit.jobs.audit.steps.at(-1)?.env)
})

test("actual deployment shell stops before mutation on disabled-health or private-plan rejection", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/deploy-dev-payment-service.yml", import.meta.url)).text(),
  ) as {
    jobs: { deploy: { steps: Array<{ name: string; run?: string }> } }
  }
  const command = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Guard and update only the disabled dev payment worker",
  )?.run
  if (!command) throw new Error("Missing guarded shell")
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-payment-shell-"))
  const bin = join(directory, "bin")
  const log = join(directory, "calls")
  try {
    await mkdir(bin)
    const executable = join(bin, "bun")
    await Bun.write(
      executable,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "sst" ]; then echo "private-stub-output"; echo "private-stub-error" >&2; fi
if [ "$FAIL_AT" = "health" ] && [ "$1" = "script/check-dev-payment-service.ts" ]; then exit 21; fi
if [ "$FAIL_AT" = "guard" ] && [ "$1" = "script/verify-payment-service-deployment.ts" ]; then exit 22; fi
exit 0
`,
    )
    await chmod(executable, 0o700)
    for (const mode of ["health", "guard", "none"]) {
      await Bun.write(log, "")
      const child = Bun.spawn(
        [
          process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash",
          "--noprofile",
          "--norc",
          "-c",
          (process.platform === "win32"
            ? 'export PATH="$(cygpath -u "$FAKE_BIN"):$PATH"\n'
            : 'export PATH="$FAKE_BIN:$PATH"\n') + command,
        ],
        {
          env: {
            ...process.env,
            FAKE_BIN: bin.replaceAll("\\", "/"),
            CALL_LOG: log.replaceAll("\\", "/"),
            RUNNER_TEMP: directory.replaceAll("\\", "/"),
            FAIL_AT: mode,
            CLOUDFLARE_ACCOUNT_ID: "cc97ad90bfaf8a1da5de612eef2658f5",
            MONGOLGPT_DOMAIN: "mgpt.mn",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect(await child.exited).toBe(mode === "health" ? 21 : mode === "guard" ? 22 : 0)
      expect(output + error).not.toContain("private-stub")
      const calls = await Bun.file(log).text()
      expect(calls.startsWith("script/check-dev-payment-service.ts before")).toBe(true)
      expect(calls.includes("sst diff")).toBe(mode !== "health")
      expect(calls.includes("sst deploy")).toBe(mode === "none")
      expect(calls.includes("script/check-dev-payment-service.ts after")).toBe(mode === "none")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
