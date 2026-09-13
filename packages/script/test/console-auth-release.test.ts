import { expect, test } from "bun:test"
import { isConsoleInstallModeChange, verifyConsoleAuthPatch } from "../src/console-auth-release"

const files = [
  "M\tpackages/console/app/src/component/header.tsx",
  "M\tpackages/console/app/src/routes/download/index.tsx",
  "M\tpackages/console/app/src/routes/index.tsx",
  "M\tpackages/console/app/src/routes/pricing/index.tsx",
  "M\tpackages/console/app/src/routes/support/index.tsx",
  "A\tpackages/console/app/test/auth-navigation-contract.test.ts",
]

test("recognizes only Bun's unchanged workspace launcher executable-bit change", () => {
  const diff =
    "diff --git a/packages/mongolgpt/bin/mongolgpt b/packages/mongolgpt/bin/mongolgpt\nold mode 100644\nnew mode 100755\n"
  expect(isConsoleInstallModeChange(diff)).toBe(true)
  for (const value of [
    "",
    diff + "@@ -1 +1 @@\n-old\n+new\n",
    diff + diff,
    diff.replaceAll("bin/mongolgpt", "src/index.ts"),
    diff.replace("new mode 100755", "new mode 120000"),
  ])
    expect(isConsoleInstallModeChange(value)).toBe(false)
})

test("accepts only the exact website auth patch", () => {
  expect(() => verifyConsoleAuthPatch(files.join("\n") + "\n")).not.toThrow()
  expect(() => verifyConsoleAuthPatch(files.toReversed().join("\r\n"))).not.toThrow()
})

test("rejects other services, missing files, duplicate files and deletion", () => {
  for (const value of [
    [...files, "M\tpackages/console/app/src/routes/zen/util/handler.ts"],
    [...files, "M\tinfra/console.ts"],
    files.slice(1),
    [...files, files[0]],
    files.map((file) => file.replace(/^M/, "D")),
    [],
  ])
    expect(() => verifyConsoleAuthPatch(value.join("\n"))).toThrow("Unapproved Console auth release files")
})

test("website hotfix is opt-in, source-pinned and guarded before its only deployment", async () => {
  const source = await Bun.file(new URL("../../../.github/workflows/deploy-dev-console.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(source) as {
    on: { workflow_dispatch: { inputs: { auth_ui_only: { default: boolean } } } }
    concurrency: { group: string; "cancel-in-progress": boolean }
    jobs: { deploy: { environment: string; steps: Array<{ name: string; if?: string; run?: string }> } }
  }
  expect(workflow.on.workflow_dispatch.inputs.auth_ui_only.default).toBe(false)
  expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
  expect(workflow.jobs.deploy.environment).toBe("dev")
  const prepare = workflow.jobs.deploy.steps.find((step) => step.name === "Prepare the pinned website-only release")
  expect(prepare?.if).toBe("inputs.auth_ui_only")
  expect(prepare?.run).toContain("bun script/prepare-console-auth-release.ts")
  const deploy = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Deploy only dev OAuth and public console to Cloudflare",
  )
  const branch = deploy?.run?.split('if [ "$AUTH_UI_ONLY" = "true" ]; then')[1]?.split('if [ "$PREVIEW_AUTH_ONLY"')[0]
  expect(branch).toBeDefined()
  expect(branch).toContain("umask 077")
  expect(branch).toContain("exit 0")
  expect(branch).not.toMatch(/db:migrate|--target AuthApi|sst (?:state|remove|secret|unlock)/)
  const order = ["bun sst diff", "verify-console-ui-deployment.ts", "bun sst deploy"].map((marker) =>
    branch!.indexOf(marker),
  )
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(branch?.match(/bun sst deploy/g)).toHaveLength(1)
  expect(branch).toContain("--stage=dev --target Console")
})
