import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { unlink } from "node:fs/promises"
import { summarizeUsageQueueDeploymentDiff } from "../src/usage-queue-deployment-audit"

const type = "cloudflare:index/workersScript:WorkersScript"
function change(name = "UsageQueueHeartbeatHandlerScript") {
  return {
    urn: `urn:pulumi:dev::mongolgpt::sst:cloudflare:Cron$sst:cloudflare:Worker$${type}::${name}`,
    type,
    op: "update",
    detailedDiff: { content: { diffKind: "update" }, "textBindings.PRIVATE_VALUE": { diffKind: "update" } },
    old: { inputs: { credential: "private-old-state" } },
    new: { inputs: { credential: "private-new-state", content: "private-source" } },
  }
}

describe("dev usage queue deployment audit", () => {
  test("summarizes both targets without printing state or nested field names", () => {
    const result = summarizeUsageQueueDeploymentDiff([change(), change("UsageQueueSubscriberFunctionScript")])
    expect(result.count).toBe(2)
    expect(result.changes.map((item) => item.target)).toEqual(["UsageQueueHeartbeat", "UsageQueueSubscriber"])
    expect(result.changes[0]).toEqual({
      target: "UsageQueueHeartbeat",
      operation: "update",
      resource: "worker-script",
      sameResourceAs: null,
      identicalPreviousEvent: null,
      identicalPreviousStatesExceptOutputs: null,
      allowedIndividually: false,
      rejectionReason: "wrong-worker-account",
      metadataEvidence: null,
      workerDiffEvidence: {
        inputPresence: [],
        unknownEngineFieldCount: 0,
        replacementMetadataKind: "absent",
        replacementFields: [],
        detailedChanges: [
          { field: "content", kind: "update", inputDiff: null },
          { field: "textBindings", kind: "update", inputDiff: null },
        ],
        unrecognizedDetailedKindCount: 0,
        detailedInputFields: [],
      },
      opaqueInputFields: [],
      opaqueInputKinds: [],
      engineDiffAvailable: false,
      engineDiffFields: [],
      fields: ["content", "textBindings"],
      detailedDiffAvailable: true,
      inputComparisonAvailable: true,
      changedInputFields: ["content", "other"],
    })
    expect(JSON.stringify(result)).not.toMatch(/private-|PRIVATE_VALUE|oldState|newState/)
  })

  test("reports out-of-scope and destructive changes without approving them", () => {
    const result = summarizeUsageQueueDeploymentDiff([{ ...change("ConsoleWorkerScript"), op: "delete" }])
    expect(result.changes[0]).toMatchObject({ target: "outside-targets", operation: "delete", resource: "other" })
    expect(JSON.stringify(result)).not.toContain("ConsoleWorkerScript")
  })

  test("does not leak unrecognized fields or their values", () => {
    const result = summarizeUsageQueueDeploymentDiff([
      { ...change(), detailedDiff: { "secret-token": "private-value" } },
    ])
    expect(result.changes[0].fields).toEqual(["other"])
    expect(JSON.stringify(result)).not.toContain("secret-token")
    expect(JSON.stringify(result)).not.toContain("private-value")
  })

  test("distinguishes missing detailed diff from no changes", () => {
    expect(summarizeUsageQueueDeploymentDiff([]).count).toBe(0)
    expect(
      summarizeUsageQueueDeploymentDiff([{ ...change(), detailedDiff: undefined }]).changes[0].detailedDiffAvailable,
    ).toBe(false)
  })

  test("distinguishes stack metadata and exact worker URL resources without disclosing unknown names", () => {
    const entry = (type: string, name: string) => ({
      ...change(),
      type,
      urn: `urn:pulumi:dev::mongolgpt::${type}::${name}`,
    })
    const report = summarizeUsageQueueDeploymentDiff([
      entry("pulumi:pulumi:Stack", "mongolgpt-dev"),
      entry("pulumi-nodejs:dynamic:Resource", "UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl"),
      entry("pulumi-nodejs:dynamic:Resource", "UsageQueueHeartbeatHandlerUrl.sst.cloudflare.WorkerUrl"),
      entry("pulumi-nodejs:dynamic:Resource", "UsageQueueHeartbeat-secret"),
    ])
    expect(report.changes.map((item) => item.resource)).toEqual(["stack-metadata", "worker-url", "worker-url", "other"])
    expect(JSON.stringify(report)).not.toContain("-secret")
  })

  test("reports input changes when detailed diff is unavailable and never prints values", () => {
    const report = summarizeUsageQueueDeploymentDiff([
      {
        ...change(),
        detailedDiff: undefined,
        old: {
          inputs: { bindings: [{ text: "private-old" }], accountId: "same", __provider: "private-provider-old" },
        },
        new: {
          inputs: { bindings: [{ text: "private-new" }], accountId: "same", __provider: "private-provider-new" },
        },
      },
      { ...change(), old: undefined, new: undefined },
    ])
    expect(report.changes[0]).toMatchObject({
      detailedDiffAvailable: false,
      inputComparisonAvailable: true,
      changedInputFields: ["__provider", "bindings"],
    })
    expect(report.changes[1]).toMatchObject({ inputComparisonAvailable: false, changedInputFields: [] })
    expect(JSON.stringify(report)).not.toContain("private-")
  })

  test("identifies provider drift and repeated resource events without exposing names or input values", () => {
    const provider = {
      ...change(),
      type: "pulumi:providers:cloudflare",
      urn: "urn:pulumi:dev::mongolgpt::pulumi:providers:cloudflare::private-provider-name",
      detailedDiff: null,
      old: { inputs: { apiToken: "private-old", version: "6.14.0" } },
      new: { inputs: { apiToken: "private-new", version: "6.15.0" } },
    }
    const reference = {
      ...change(),
      type: "sst:sst:LinkRef",
      urn: "urn:pulumi:dev::mongolgpt::sst:sst:LinkRef::UsageQueueHeartbeatHandlerLinkRef",
      old: { inputs: { properties: { url: "private-old-url" } } },
      new: { inputs: { properties: { url: "private-new-url" } } },
    }
    const report = summarizeUsageQueueDeploymentDiff([provider, reference, reference])
    expect(report.changes[0]).toMatchObject({
      resource: "cloudflare-provider",
      changedInputFields: ["apiToken", "version"],
      allowedIndividually: false,
    })
    expect(report.changes[1]).toMatchObject({ resource: "link-reference", sameResourceAs: null })
    expect(report.changes[2]).toMatchObject({
      sameResourceAs: 1,
      identicalPreviousEvent: true,
      allowedIndividually: false,
    })
    expect(JSON.stringify(report)).not.toContain("private-")
  })

  test("describes engine metadata and computed links without allowing them or exposing values", () => {
    const provider = {
      ...change(),
      type: "pulumi:providers:pulumi-nodejs",
      urn: "urn:pulumi:dev::mongolgpt::pulumi:providers:pulumi-nodejs::private-provider",
      old: { inputs: {} },
      new: { inputs: { __internal: {} } },
    }
    const reference = {
      ...change(),
      type: "sst:sst:LinkRef",
      urn: "urn:pulumi:dev::mongolgpt::sst:sst:LinkRef::UsageQueueHeartbeatHandlerLinkRef",
      old: { inputs: { properties: { url: "https://private-url" }, include: "private-binding" } },
      new: {
        inputs: { properties: { url: "04da6b54-80e4-46f7-96ec-b56ff0331ba9" }, include: "private-binding" },
      },
    }
    const report = summarizeUsageQueueDeploymentDiff([
      provider,
      {
        ...provider,
        new: { inputs: { __internal: { pluginDownloadURL: "private-plugin", "private-key": "secret" } } },
      },
      reference,
      { ...reference, new: { inputs: { ...reference.new.inputs, properties: { url: "private-concrete-change" } } } },
    ])
    expect(report.changes[0]).toMatchObject({
      changedInputFields: ["__internal"],
      rejectionReason: "unapproved-provider-configuration",
      metadataEvidence: { emptyInternalMetadataAdded: true, changedInternalFields: [] },
    })
    expect(report.changes[1]).toMatchObject({
      identicalPreviousEvent: false,
      metadataEvidence: { emptyInternalMetadataAdded: false, changedInternalFields: ["other", "pluginDownloadURL"] },
    })
    expect(report.changes[2].metadataEvidence).toEqual({
      onlyUrlPropertyChanged: true,
      newUrlIsComputed: true,
      includeUnchanged: true,
    })
    expect(report.changes[3]).toMatchObject({
      identicalPreviousEvent: false,
      metadataEvidence: { newUrlIsComputed: false },
    })
    expect(report.changes.every((item) => !item.allowedIndividually)).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/private-|secret|04da6b54/)
  })

  test("classifies hidden input shapes and engine diff keys without leaking payloads", () => {
    const pulumiSignatureProperty = "4dabf18193072939515e22adb298388d"
    const pulumiHiddenValueSignature = "1b47061264138c4ac30d75fd1eb44270"
    const report = summarizeUsageQueueDeploymentDiff([
      {
        ...change(),
        diffs: ["contentSha256", "etag", "modifiedOn", "private-field"],
        old: {
          inputs: { bindings: { [pulumiSignatureProperty]: pulumiHiddenValueSignature, ciphertext: "[secret]" } },
        },
        new: {
          inputs: {
            bindings: { [pulumiSignatureProperty]: pulumiHiddenValueSignature, ciphertext: "[secret]" },
            contentFile: "04da6b54-80e4-46f7-96ec-b56ff0331ba9",
            "private-field": { secure: "private-value" },
          },
        },
      },
    ])
    expect(report.changes[0]).toMatchObject({
      opaqueInputFields: ["bindings", "contentFile", "other"],
      opaqueInputKinds: ["computed", "encrypted-value", "secret-mask", "secret-wrapper"],
      engineDiffAvailable: true,
      engineDiffFields: ["contentSha256", "etag", "modifiedOn", "other"],
      allowedIndividually: false,
    })
    expect(JSON.stringify(report)).not.toMatch(/private-|04da6b54|4dabf181/)
  })

  test("reports only known provider version values while keeping unknown config keys private", () => {
    const provider = {
      ...change(),
      type: "pulumi:providers:pulumi-nodejs",
      urn: "urn:pulumi:dev::mongolgpt::pulumi:providers:pulumi-nodejs::default",
      old: { inputs: { "cloudflare:version": "6.14.0", "random:version": "4.19.2", "private:config": "private-old" } },
      new: {
        inputs: { "cloudflare:version": "6.15.0", "random:version": "private-new", "private:config": "private-new" },
      },
    }
    const report = summarizeUsageQueueDeploymentDiff([provider])
    expect(report.changes[0]).toMatchObject({
      allowedIndividually: false,
      changedInputFields: ["cloudflare:version", "other", "random:version"],
      metadataEvidence: {
        configurationChanges: [
          {
            field: "cloudflare:version",
            namespaced: true,
            oldKind: "string",
            newKind: "string",
            oldVersion: "6.14.0",
            newVersion: "6.15.0",
          },
          {
            field: "random:version",
            namespaced: true,
            oldKind: "string",
            newKind: "string",
            oldVersion: "4.19.2",
            newVersion: null,
          },
          {
            field: "other",
            namespaced: true,
            oldKind: "string",
            newKind: "string",
            oldVersion: null,
            newVersion: null,
          },
        ],
      },
    })
    expect(JSON.stringify(report)).not.toContain("private")
  })

  test("diagnoses known worker fields and input presence without authorizing settings or exposing values", () => {
    const entry = {
      ...change(),
      diffs: ["id", "limits", "tailConsumers", "etag", "private-key", 123],
      keys: ["limits", "private-key"],
      detailedDiff: {
        "limits.private-child": { inputDiff: true },
        "private-key": { inputDiff: true },
        etag: { inputDiff: false },
      },
      old: { inputs: { etag: null, limits: { cpuMs: "private-old" } }, outputs: { id: "private-id" } },
      new: { inputs: { limits: { cpuMs: "private-new" }, tailConsumers: [] }, outputs: { id: "private-id" } },
    }
    const report = summarizeUsageQueueDeploymentDiff([entry])
    expect(report.changes[0].engineDiffFields).toEqual(["etag", "id", "limits", "other", "tailConsumers"])
    expect(report.changes[0].workerDiffEvidence).toEqual({
      inputPresence: [
        { field: "etag", old: true, new: false },
        { field: "id", old: false, new: false },
        { field: "limits", old: true, new: true },
        { field: "tailConsumers", old: false, new: true },
      ],
      unknownEngineFieldCount: 2,
      replacementMetadataKind: "array",
      replacementFields: ["limits", "other"],
      detailedChanges: [
        { field: "limits", kind: "other", inputDiff: true },
        { field: "other", kind: "other", inputDiff: true },
        { field: "etag", kind: "other", inputDiff: false },
      ],
      unrecognizedDetailedKindCount: 3,
      detailedInputFields: ["limits", "other"],
    })
    expect(report.changes[0].allowedIndividually).toBe(false)
    expect(report.previewRejectionReason).not.toBeNull()
    expect(JSON.stringify(report)).not.toMatch(/private-|cpuMs/)
  })

  test("reports whole-preview rejection and output-only event differences separately", () => {
    const entry = {
      urn: "urn:pulumi:dev::mongolgpt::pulumi:pulumi:Stack::mongolgpt-dev",
      type: "pulumi:pulumi:Stack",
      op: "update",
      old: { inputs: {}, outputs: { private: "private-old" } },
      new: { inputs: {}, outputs: { private: "private-new" } },
    }
    expect(summarizeUsageQueueDeploymentDiff([entry]).previewRejectionReason).toBeNull()
    const repeated = { ...entry, new: { ...entry.new, outputs: { private: "private-different" } } }
    const report = summarizeUsageQueueDeploymentDiff([entry, repeated])
    expect(report.changes.every((change) => change.allowedIndividually)).toBe(true)
    expect(report.previewRejectionReason).toBe("duplicate-resource")
    expect(report.changes[1].identicalPreviousEvent).toBe(false)
    expect(report.changes[1].identicalPreviousStatesExceptOutputs).toBe(true)
    expect(
      summarizeUsageQueueDeploymentDiff([entry, { ...repeated, new: { ...repeated.new, inputs: { private: true } } }])
        .changes[1].identicalPreviousStatesExceptOutputs,
    ).toBe(false)
    expect(JSON.stringify(report)).not.toContain("private")
  })

  test("distinguishes the actual masked-binding guard failure causes", () => {
    const pulumiSignatureProperty = "4dabf18193072939515e22adb298388d"
    const pulumiHiddenValueSignature = "1b47061264138c4ac30d75fd1eb44270"
    const inputs = {
      accountId: "cc97ad90bfaf8a1da5de612eef2658f5",
      scriptName: "mongolgpt-dev-usagequeueheartbeathandlerscript",
      contentFile: "private-worker.js",
      contentSha256: "a".repeat(64),
      bindings: { [pulumiSignatureProperty]: pulumiHiddenValueSignature, ciphertext: "[secret]" },
    }
    const entry = {
      ...change(),
      detailedDiff: null,
      keys: [],
      diffs: ["contentSha256", "etag"],
      old: { inputs },
      new: { inputs: { ...inputs, contentSha256: "b".repeat(64) } },
    }
    expect(summarizeUsageQueueDeploymentDiff([entry]).previewRejectionReason).toBeNull()
    const report = summarizeUsageQueueDeploymentDiff([
      { ...entry, diffs: ["contentSha256", "private-unknown"] },
      {
        ...entry,
        old: { inputs: { ...entry.old.inputs, etag: null } },
        new: { inputs: { ...entry.new.inputs, etag: null } },
      },
      { ...entry, keys: ["private-replacement"] },
    ])
    expect(report.changes.map((change) => change.rejectionReason)).toEqual([
      "unproved-worker-secret-bindings",
      "unproved-worker-secret-bindings",
      "unproved-worker-secret-bindings",
    ])
    expect(report.changes[0].workerDiffEvidence?.unknownEngineFieldCount).toBe(1)
    expect(report.changes[1].workerDiffEvidence?.inputPresence).toContainEqual({ field: "etag", old: true, new: true })
    expect(report.changes[2].workerDiffEvidence?.replacementFields).toEqual(["other"])
    expect(report.previewRejectionReason).toBe("unproved-worker-secret-bindings")
    expect(JSON.stringify(report)).not.toMatch(/private-|4dabf181|1b470612|aaaaaa|bbbbbb/)
  })

  test("reports detailed replacement kinds without leaking unknown kinds or nested paths", () => {
    const report = summarizeUsageQueueDeploymentDiff([
      {
        ...change(),
        keys: [],
        detailedDiff: {
          etag: { diffKind: "update", inputDiff: false },
          "etag.private-child": { diffKind: "update-replace", inputDiff: false },
          "bindings.private-name": { diffKind: "add", inputDiff: true },
          "private-field": { diffKind: "private-kind", inputDiff: "private-boolean" },
          "private-other": "private-value",
        },
      },
    ])
    expect(report.changes[0].workerDiffEvidence?.detailedChanges).toEqual([
      { field: "etag", kind: "update", inputDiff: false },
      { field: "etag", kind: "update-replace", inputDiff: false },
      { field: "bindings", kind: "add", inputDiff: true },
      { field: "other", kind: "other", inputDiff: null },
    ])
    expect(report.changes[0].workerDiffEvidence?.unrecognizedDetailedKindCount).toBe(2)
    expect(JSON.stringify(report)).not.toContain("private-")
  })

  test("rejects malformed metadata, wrong account stack or stage, and oversized arrays", () => {
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
      expect(() => summarizeUsageQueueDeploymentDiff(invalid)).toThrow()
  })

  test("workflow is manual, dev-only, serialized, and has no mutation or raw state artifact", async () => {
    const source = await Bun.file(
      new URL("../../../.github/workflows/audit-dev-usage-queue.yml", import.meta.url),
    ).text()
    const workflow = Bun.YAML.parse(source) as {
      on: unknown
      permissions: unknown
      concurrency: unknown
      env: Record<string, string>
      jobs: { audit: { environment: string; if: string; steps: Array<{ run?: string }> } }
    }
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
    expect(workflow.env.PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW).toBe("true")
    expect(workflow.jobs.audit.environment).toBe("dev")
    expect(workflow.jobs.audit.if).toContain("github.repository == 'sergei10a-rgb/mongolgpt'")
    expect(workflow.jobs.audit.if).toContain("github.ref == 'refs/heads/main'")
    const commands = workflow.jobs.audit.steps.map((step: { run?: string }) => step.run ?? "").join("\n")
    expect(commands).toContain("sst diff --stage=dev --target UsageQueueSubscriber,UsageQueueHeartbeatHandler --json")
    expect(commands).toContain('verify-usage-queue-deployment.ts "$diff_file"')
    expect(commands).toContain("umask 077")
    expect(commands).toContain("trap 'rm -f")
    expect(commands).not.toMatch(/sst (?:deploy|refresh|remove|unlock|state)|--decrypt|db:migrate|wrangler|curl|cat /)
    expect(source).not.toContain("upload-artifact")
  })

  test("actual CLI redacts private state and fails closed on invalid input", async () => {
    const file = join(tmpdir(), `mongolgpt-queue-audit-${crypto.randomUUID()}.json`)
    const script = resolve(import.meta.dir, "../../../script/audit-usage-queue-deployment.ts")
    try {
      for (const input of [
        JSON.stringify([change()]),
        '{"private-secret":"unterminated',
        JSON.stringify([
          {
            ...change(),
            urn: change().urn.replace("pulumi:dev", "pulumi:production"),
          },
        ]),
      ]) {
        await Bun.write(file, input)
        const child = Bun.spawn([process.execPath, script, file], { stdout: "pipe", stderr: "pipe" })
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        const status = await child.exited
        expect(stdout + stderr).not.toMatch(/private-|PRIVATE_VALUE|oldState|newState/)
        if (input === JSON.stringify([change()])) {
          expect(status).toBe(0)
          expect(JSON.parse(stdout).changes[0].resource).toBe("worker-script")
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
