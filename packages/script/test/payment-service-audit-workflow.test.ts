import { expect, test } from "bun:test"

test("payment service audit is manual, owner/dev-scoped and never deploys", async () => {
  const source = await Bun.file(
    new URL("../../../.github/workflows/audit-dev-payment-service.yml", import.meta.url),
  ).text()
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>
    permissions: unknown
    concurrency: unknown
    env: Record<string, string>
    jobs: {
      audit: {
        if: string
        environment: string
        steps: Array<{ name: string; run?: string; uses?: string; env?: Record<string, string> }>
      }
    }
  }
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
  expect(Object.keys(workflow.jobs)).toEqual(["audit"])
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.jobs.audit.environment).toBe("dev")
  expect(workflow.jobs.audit.if).toBe(
    "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
  )
  expect(workflow.env.PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW).toBe("true")
  expect(workflow.env.MONGOLGPT_DOMAIN).toBe("${{ vars.MONGOLGPT_DOMAIN }}")
  expect(workflow.env.MONGOLGPT_PAYMENT_ENVIRONMENT).toBe("disabled")
  for (const name of [
    "MONGOLGPT_ENABLE_REAL_PAYMENTS",
    "MONGOLGPT_ENABLE_ADMIN",
    "MONGOLGPT_ENABLE_D1_BACKUPS",
    "MONGOLGPT_ENABLE_MONITORING",
    "MONGOLGPT_ENABLE_ROOT_PREVIEW_ALIAS",
    "MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS",
    "MONGOLGPT_ENABLE_LEGACY_STRIPE",
    "MONGOLGPT_ENABLE_SHARE_SERVICE",
    "MONGOLGPT_ENABLE_SYNC_SERVICE",
  ]) {
    expect(workflow.env[name]).toBe("false")
  }
  const steps = workflow.jobs.audit.steps
  const verification = steps.find((step) => step.name === "Verify read-only private payment reporting")
  const preview = steps.find((step) => step.name === "Preview disabled dev payment service without deploying")
  if (!verification?.run || !preview?.run) throw new Error("Payment audit workflow steps are missing")
  expect(steps.indexOf(verification)).toBeLessThan(steps.indexOf(preview))
  expect(verification.run).toContain("test/payment-service-deployment-audit.test.ts")
  expect(verification.run).toContain("test/payment-service-audit-workflow.test.ts")
  expect(verification.run).toContain("test/usage-queue-deployment-audit.test.ts")
  expect(verification.run).toContain("test/usage-queue-deployment-guard.test.ts")
  expect(preview.env?.CLOUDFLARE_ACCOUNT_ID).toBe("${{ vars.CLOUDFLARE_DEFAULT_ACCOUNT_ID }}")
  expect(preview.env?.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}")
  expect(preview.run).toContain('"$CLOUDFLARE_ACCOUNT_ID" != "cc97ad90bfaf8a1da5de612eef2658f5"')
  expect(preview.run).toContain('"$MONGOLGPT_DOMAIN" != "mgpt.mn"')
  expect(preview.run.indexOf("exit 1")).toBeLessThan(preview.run.indexOf("bun sst diff"))
  const commands = steps.map((step) => step.run ?? "").join("\n")
  expect(commands.match(/bun sst [^\n]*/g)).toEqual([
    'bun sst diff --stage=dev --target PaymentService --json --print-logs >"$diff_file" 2>"$stderr_file"; then',
  ])
  expect(commands).toContain("umask 077")
  expect(commands).toContain('mktemp "$RUNNER_TEMP/mongolgpt-payment-diff.XXXXXX"')
  expect(commands).toContain('mktemp "$RUNNER_TEMP/mongolgpt-payment-stderr.XXXXXX"')
  expect(commands).toContain('trap \'rm -f "$diff_file" "$stderr_file"\' EXIT')
  expect(commands).toContain('bun script/audit-payment-service-deployment.ts "$diff_file"')
  expect(commands).toContain("No payment deployment was authorized or performed")
  expect(commands).not.toMatch(
    /sst (?:deploy|remove|refresh|unlock|state|secret|shell)|--decrypt|db:migrate|wrangler|curl|cat /,
  )
  expect(commands).not.toContain("verify-usage-queue-deployment.ts")
  expect(source).not.toMatch(/upload-artifact|REAL_PAYMENT_CONFIRMATION|secrets\.(?:QPAY|BONUM)/)
})
