import { describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  summarizePaymentServiceDeploymentDiff,
  summarizeUsageQueueDeploymentDiff,
} from "../src/usage-queue-deployment-audit"

const workerType = "cloudflare:index/workersScript:WorkersScript"

function change(name = "PaymentServiceScript") {
  return {
    urn: `urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$${workerType}::${name}`,
    type: workerType,
    op: "update",
    detailedDiff: { content: { diffKind: "update" }, "bindings.PRIVATE_TOKEN": { diffKind: "update" } },
    old: { inputs: { credential: "private-old-state" }, outputs: { code: "private-old-output" } },
    new: {
      inputs: { credential: "private-new-state", content: "private-source" },
      outputs: { code: "private-new-output" },
    },
  }
}

describe("dev payment service deployment audit", () => {
  test("summarizes only fixed PaymentService boundaries without approving or evaluating changes", () => {
    const report = summarizePaymentServiceDeploymentDiff([
      change(),
      {
        ...change("PaymentServiceUrl.sst.cloudflare.WorkerUrl"),
        type: "pulumi-nodejs:dynamic:Resource",
        urn: "urn:pulumi:dev::mongolgpt::pulumi-nodejs:dynamic:Resource::PaymentServiceUrl.sst.cloudflare.WorkerUrl",
      },
      {
        ...change("PaymentService"),
        type: "sst:cloudflare:Worker",
        urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker::PaymentService",
      },
    ])
    expect(report).toMatchObject({
      stage: "dev",
      targets: ["PaymentService"],
      count: 3,
      previewRejectionReason: "not-evaluated",
    })
    expect(report.changes.map((item) => item.target)).toEqual(["PaymentService", "PaymentService", "PaymentService"])
    expect(report.changes.map((item) => item.resource)).toEqual(["worker-script", "worker-url", "component"])
    expect(report.changes.every((item) => item.allowedIndividually === false)).toBe(true)
    expect(report.changes.every((item) => item.rejectionReason === "not-evaluated")).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/private-|PRIVATE_TOKEN|PaymentServiceScript|code/)
  })

  test("reports no-op previews as not approved and not evaluated", () => {
    const report = summarizePaymentServiceDeploymentDiff([])
    expect(report).toEqual({
      stage: "dev",
      targets: ["PaymentService"],
      count: 0,
      previewRejectionReason: "not-evaluated",
      changes: [],
    })
  })

  test("keeps generic deployment metadata while redacting unknown names and values", () => {
    const entry = (type: string, name: string) => ({
      ...change(),
      type,
      urn: `urn:pulumi:dev::mongolgpt::${type}::${name}`,
    })
    const report = summarizePaymentServiceDeploymentDiff([
      entry("pulumi:pulumi:Stack", "mongolgpt-dev"),
      entry("pulumi:providers:cloudflare", "private-provider"),
      entry("pulumi:providers:pulumi-nodejs", "default"),
      entry("sst:sst:Version", "PaymentServiceVersion"),
      entry("sst:sst:LinkRef", "PaymentServiceLinkRef"),
      entry("pulumi-nodejs:dynamic:Resource", "PaymentServicePrivateUrl"),
    ])
    expect(report.changes.map((item) => item.resource)).toEqual([
      "stack-metadata",
      "cloudflare-provider",
      "dynamic-provider",
      "component-version",
      "link-reference",
      "other",
    ])
    expect(report.changes.every((item) => !item.allowedIndividually)).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/private-|PaymentServicePrivateUrl/)
  })

  test("reports destructive and out-of-scope changes without exposing resource names or approving them", () => {
    const report = summarizePaymentServiceDeploymentDiff([{ ...change("ConsoleWorkerScript"), op: "delete" }])
    expect(report.changes[0]).toMatchObject({
      target: "outside-targets",
      operation: "delete",
      resource: "other",
      allowedIndividually: false,
      rejectionReason: "not-evaluated",
    })
    expect(JSON.stringify(report)).not.toContain("ConsoleWorkerScript")
  })

  test("redacts unknown diff keys, paths, secret markers, and values", () => {
    const pulumiSignatureProperty = "4dabf18193072939515e22adb298388d"
    const pulumiHiddenValueSignature = "1b47061264138c4ac30d75fd1eb44270"
    const report = summarizePaymentServiceDeploymentDiff([
      {
        ...change(),
        diffs: ["contentSha256", "private-field"],
        detailedDiff: { "private.path": { diffKind: "private-kind", inputDiff: "private-input" } },
        old: { inputs: { bindings: { [pulumiSignatureProperty]: pulumiHiddenValueSignature } } },
        new: { inputs: { "private-field": { secure: "private-value" } } },
      },
    ])
    expect(report.changes[0]).toMatchObject({
      opaqueInputFields: ["bindings", "other"],
      opaqueInputKinds: ["encrypted-value", "secret-wrapper"],
      engineDiffFields: ["contentSha256", "other"],
      fields: ["other"],
    })
    expect(JSON.stringify(report)).not.toMatch(/private-|4dabf181|1b470612/)
  })

  test("rejects malformed, wrong stage, wrong stack, invalid metadata, and oversized previews", () => {
    for (const invalid of [
      null,
      {},
      [null],
      [{}],
      Array(2_001).fill(change()),
      [{ ...change(), urn: change().urn.replace("pulumi:dev", "pulumi:production") }],
      [{ ...change(), urn: change().urn.replace("::mongolgpt::", "::another::") }],
      [{ ...change(), type: "other" }],
      [{ ...change(), op: "private-secret" }],
    ])
      expect(() => summarizePaymentServiceDeploymentDiff(invalid)).toThrow()
    expect(() =>
      summarizeUsageQueueDeploymentDiff([
        { ...change(), urn: change().urn.replace("pulumi:dev", "pulumi:production") },
      ]),
    ).toThrow("Queue deployment audit requires mongolgpt/dev")
  })

  test("actual CLI rejects oversized files and missing or extra arguments without printing paths", async () => {
    const file = join(tmpdir(), `private-payment-audit-${crypto.randomUUID()}.json`)
    const script = resolve(import.meta.dir, "../../../script/audit-payment-service-deployment.ts")
    try {
      await Bun.write(file, " ".repeat(16 * 1024 * 1024 + 1))
      for (const args of [[file], [], [file, "private-extra-argument"], [`${file}-missing`]]) {
        const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        expect(await child.exited).toBe(1)
        expect(stdout).toBe("")
        expect(stderr.trim()).toBe("Dev payment service deployment audit failed; private diff content was not printed.")
        expect(stderr).not.toContain(file)
        expect(stderr).not.toContain("private-extra-argument")
      }
    } finally {
      await unlink(file)
    }
  })

  test("actual CLI redacts private state and fails closed on invalid input", async () => {
    const file = join(tmpdir(), `mongolgpt-payment-audit-${crypto.randomUUID()}.json`)
    const script = resolve(import.meta.dir, "../../../script/audit-payment-service-deployment.ts")
    try {
      for (const input of [
        JSON.stringify([change()]),
        '{"private-secret":"unterminated',
        JSON.stringify([{ ...change(), urn: change().urn.replace("pulumi:dev", "pulumi:production") }]),
        JSON.stringify([{ ...change("ConsoleWorkerScript"), op: "delete" }]),
      ]) {
        await Bun.write(file, input)
        const child = Bun.spawn([process.execPath, script, file], { stdout: "pipe", stderr: "pipe" })
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        const status = await child.exited
        expect(stdout + stderr).not.toMatch(/private-|PRIVATE_TOKEN|oldState|newState|ConsoleWorkerScript/)
        if (
          input === JSON.stringify([change()]) ||
          input === JSON.stringify([{ ...change("ConsoleWorkerScript"), op: "delete" }])
        ) {
          expect(status).toBe(0)
          expect(JSON.parse(stdout).changes[0].allowedIndividually).toBe(false)
          expect(JSON.parse(stdout).changes[0].rejectionReason).toBe("not-evaluated")
          expect(stderr).toBe("")
          continue
        }
        expect(status).toBe(1)
        expect(stdout).toBe("")
        expect(stderr).toContain("private diff content was not printed")
      }
    } finally {
      await unlink(file)
    }
  })
})
