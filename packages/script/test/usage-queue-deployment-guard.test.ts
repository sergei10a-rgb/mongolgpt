import { describe, expect, test } from "bun:test"
import { UsageQueueDeploymentGuardError, verifyUsageQueueDeploymentDiff } from "../src/usage-queue-deployment-guard"

const accountId = "cc97ad90bfaf8a1da5de612eef2658f5"
const workerType = "cloudflare:index/workersScript:WorkersScript"
const urlType = "pulumi-nodejs:dynamic:Resource"
const oldHash = "a".repeat(64)
const newHash = "b".repeat(64)
const privateValue = "private-do-not-print"
const unknownString = "04da6b54-80e4-46f7-96ec-b56ff0331ba9"

const workerTargets = {
  UsageQueueSubscriberFunctionScript: "mongolgpt-dev-usagequeuesubscriberfunctionscript",
  UsageQueueHeartbeatHandlerScript: "mongolgpt-dev-usagequeueheartbeathandlerscript",
} as const

const urlTargets = {
  "UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl": "mongolgpt-dev-usagequeuesubscriberfunctionscript",
  "UsageQueueHeartbeatHandlerUrl.sst.cloudflare.WorkerUrl": "mongolgpt-dev-usagequeueheartbeathandlerscript",
} as const

describe("usage queue deployment guard", () => {
  test("permits both worker updates, URL invalidations, root stack metadata, and same dev entries", () => {
    const result = verifyUsageQueueDeploymentDiff([
      worker("UsageQueueSubscriberFunctionScript"),
      worker("UsageQueueHeartbeatHandlerScript"),
      url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl"),
      url("UsageQueueHeartbeatHandlerUrl.sst.cloudflare.WorkerUrl"),
      stack(),
      same("sst:cloudflare:QueueWorkerSubscriber", "UsageQueueSubscriber"),
    ])
    expect(result).toEqual({ workerUpdates: 2, urlUpdates: 2 })
    expect(JSON.stringify(result)).not.toContain(privateValue)
  })

  test("rejects wrong stage, stack, account, logical name, or script name", () => {
    rejects({ ...worker(), urn: worker().urn.replace("pulumi:dev", "pulumi:prod") })
    rejects({ ...worker(), urn: worker().urn.replace("::mongolgpt::", "::mongolgpt-admin::") })
    rejects(worker("ConsoleWorkerScript" as keyof typeof workerTargets))
    rejects(worker("UsageQueueSubscriberFunctionScript", { scriptName: "wrong-script" }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { accountId: "wrong-account" }))
  })

  test("permits only the heartbeat component's computed URL and output-only repeated event", () => {
    const entry = heartbeatLink()
    const resolved = {
      ...entry,
      new: { ...entry.new, outputs: { properties: { url: unknownString }, target: "UsageQueueHeartbeatHandler" } },
    }
    expect(verifyUsageQueueDeploymentDiff([worker(), entry, resolved])).toEqual({ workerUpdates: 1, urlUpdates: 0 })
    rejects([entry, resolved, resolved])
    rejects([same(entry.type, "UsageQueueHeartbeatHandlerLinkRef"), entry])
    rejects({ ...entry, op: "create" })
    rejects({ ...entry, keys: ["properties"] })
    rejects({ ...entry, urn: entry.urn.replace("HandlerLinkRef", "OtherLinkRef") })
    rejects({
      ...entry,
      new: { ...entry.new, inputs: { ...entry.new.inputs, properties: { url: "https://changed.example" } } },
    })
    rejects({
      ...entry,
      new: { ...entry.new, inputs: { ...entry.new.inputs, properties: { url: unknownString, other: true } } },
    })
    rejects({ ...entry, new: { ...entry.new, inputs: { ...entry.new.inputs, include: [] } } })
    rejects({ ...entry, new: { ...entry.new, inputs: { ...entry.new.inputs, other: privateValue } } })
    rejects({ ...entry, old: { ...entry.old, custom: true }, new: { ...entry.new, custom: true } })
    rejects([
      entry,
      { ...resolved, old: { ...resolved.old, id: "different" }, new: { ...resolved.new, id: "different" } },
    ])
  })

  test("rejects every disallowed worker input mutation", () => {
    rejects(worker("UsageQueueSubscriberFunctionScript", { stablePatch: { bindings: [{ name: "NEW" }] } }))
    rejects(
      worker("UsageQueueSubscriberFunctionScript", {
        stablePatch: { bindings: [{ name: "ENV", text: unknownString }] },
      }),
    )
    rejects(worker("UsageQueueSubscriberFunctionScript", { stablePatch: { compatibilityDate: "2026-01-02" } }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { stablePatch: { __provider: "changed-provider" } }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { newContentSha256: "not-a-64-hex-hash" }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { newContentSha256: oldHash }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { deleteInput: "bindings" }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { addInput: ["unexpected", "value"] }))
  })

  test("accepts only the observed dynamic-provider version metadata additions", () => {
    const type = "pulumi:providers:pulumi-nodejs"
    const urn = urnFor(type, "default")
    const versions = { "cloudflare:version": "6.15.0", "random:version": "4.19.2" }
    const entry = { urn, type, op: "update", old: state(urn, type, {}), new: state(urn, type, versions) }
    expect(verifyUsageQueueDeploymentDiff([entry, worker()])).toEqual({ workerUpdates: 1, urlUpdates: 0 })
    rejects({ ...entry, op: "create" })
    rejects({ ...entry, keys: ["cloudflare:version"] })
    rejects({ ...entry, diffs: ["apiToken"] })
    rejects({ ...entry, detailedDiff: { apiToken: { kind: "update" } } })
    rejects({ ...entry, old: state(urn, type, { "cloudflare:version": "6.14.0" }) })
    for (const inputs of [
      { ...versions, "cloudflare:version": "6.16.0" },
      { ...versions, "random:version": "4.20.0" },
      { "cloudflare:version": "6.15.0" },
      { ...versions, apiToken: privateValue },
      { ...versions, "private:config": true },
      { ...versions, __internal: {} },
    ])
      rejects({ ...entry, new: state(urn, type, inputs) })
    rejects({
      ...entry,
      old: state(urn, type, { apiToken: "[secret]" }),
      new: state(urn, type, { ...versions, apiToken: "[secret]" }),
    })
    rejects({ ...entry, new: { ...entry.new, id: "different-provider" } })
    rejects([entry, entry])
  })

  test("rejects disallowed URL input mutation and unchanged etag", () => {
    expect(
      verifyUsageQueueDeploymentDiff([
        url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { newEtag: unknownString }),
      ]),
    ).toEqual({
      workerUpdates: 0,
      urlUpdates: 1,
    })
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { stablePatch: { enabled: false } }))
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { stablePatch: { scriptName: "wrong" } }))
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { stablePatch: { accountId: "wrong" } }))
    rejects(
      url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { stablePatch: { enabled: unknownString } }),
    )
    rejects(
      url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { stablePatch: { accountId: unknownString } }),
    )
    rejects(
      url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", {
        oldInputPatch: { __provider: "same" },
        stablePatch: { __provider: "changed" },
      }),
    )
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { addInput: ["other", true] }))
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { newEtag: "old-etag" }))
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { newEtag: "" }))
    rejects(
      url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { stablePatch: { etag: { computed: true } } }),
    )
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { deleteInput: "etag" }))
    rejects(
      url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", {
        oldStatePatch: { provider: unknownString },
        newStatePatch: { provider: unknownString },
      }),
    )
  })

  test("rejects opaque or missing input proof regardless of detailedDiff", () => {
    rejects(worker("UsageQueueSubscriberFunctionScript", { opaque: true }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { omitOldState: true }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { omitNewState: true }))
    rejects(worker("UsageQueueSubscriberFunctionScript", { omitInputs: true }))
    rejects({ ...worker(), detailedDiff: { contentSha256: { diffKind: "update" } }, old: undefined })
    const actual = worker()
    rejects({ ...actual, old: undefined, new: undefined, oldState: actual.old, newState: actual.new })
    rejects(url("UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl", { opaque: true }))
  })

  test("requires unredacted engine change metadata for identical secret binding masks", () => {
    const entry = worker()
    const bindings = [{ type: "secret_text", name: "TOKEN", text: "[secret]" }]
    const redacted = {
      ...entry,
      diffs: ["contentSha256"],
      detailedDiff: null,
      old: { ...entry.old, inputs: { ...entry.old!.inputs, bindings } },
      new: { ...entry.new, inputs: { ...entry.new!.inputs, contentFile: entry.old!.inputs!.contentFile, bindings } },
    }
    expect(verifyUsageQueueDeploymentDiff([redacted])).toEqual({ workerUpdates: 1, urlUpdates: 0 })
    for (const key of [
      "createdOn",
      "etag",
      "handlers",
      "hasAssets",
      "hasModules",
      "lastDeployedFrom",
      "migrationTag",
      "modifiedOn",
      "namedHandlers",
      "placementMode",
      "placementStatus",
      "startupTimeMs",
    ]) {
      const computed = { ...redacted, diffs: ["contentSha256", key] }
      expect(verifyUsageQueueDeploymentDiff([computed])).toEqual({ workerUpdates: 1, urlUpdates: 0 })
      rejects({
        ...computed,
        old: { ...computed.old, inputs: { ...computed.old.inputs, [key]: "same" } },
        new: { ...computed.new, inputs: { ...computed.new.inputs, [key]: "same" } },
      })
      rejects({ ...computed, detailedDiff: { [key]: { diffKind: "update", inputDiff: true } } })
    }
    for (const diffs of [undefined, [], ["bindings"], ["contentSha256", "bindings"], ["contentSha256", privateValue]])
      rejects({ ...redacted, diffs })
    rejects({ ...redacted, keys: ["bindings"] })
    rejects({ ...redacted, detailedDiff: { "bindings[0].text": { diffKind: "update" } } })
    rejects({ ...redacted, new: { ...redacted.new, inputs: { ...redacted.new.inputs, bindings: [] } } })
    for (const hidden of [
      unknownString,
      { __pulumiUnknown: true },
      { secure: "[secret]" },
      { ciphertext: "[secret]" },
    ]) {
      const bindings = [{ type: "secret_text", name: "TOKEN", text: hidden }]
      rejects({
        ...redacted,
        old: { ...redacted.old, inputs: { ...redacted.old.inputs, bindings } },
        new: { ...redacted.new, inputs: { ...redacted.new.inputs, bindings } },
      })
    }
    rejects({ ...redacted, new: { ...redacted.new, inputs: { ...redacted.new.inputs, contentSha256: "[secret]" } } })
    const pulumiSignatureProperty = "4dabf18193072939515e22adb298388d"
    const pulumiHiddenValueSignature = "1b47061264138c4ac30d75fd1eb44270"
    const wrapped = { [pulumiSignatureProperty]: pulumiHiddenValueSignature, ciphertext: "[secret]" }
    expect(
      verifyUsageQueueDeploymentDiff([
        {
          ...redacted,
          old: { ...redacted.old, inputs: { ...redacted.old.inputs, bindings: wrapped } },
          new: { ...redacted.new, inputs: { ...redacted.new.inputs, bindings: wrapped } },
        },
      ]),
    ).toEqual({ workerUpdates: 1, urlUpdates: 0 })
    for (const bindings of [
      { ...wrapped, ciphertext: unknownString },
      { ...wrapped, ciphertext: privateValue },
      { [pulumiSignatureProperty]: pulumiHiddenValueSignature, value: "[secret]" },
      { [pulumiSignatureProperty]: pulumiHiddenValueSignature, plaintext: privateValue },
      { ...wrapped, [pulumiSignatureProperty]: "unknown-serialization" },
      { ...wrapped, extra: true },
    ])
      rejects({
        ...redacted,
        old: { ...redacted.old, inputs: { ...redacted.old.inputs, bindings } },
        new: { ...redacted.new, inputs: { ...redacted.new.inputs, bindings } },
      })
  })

  test("permits only unconfigured optional-computed root additions from the precise worker preview", () => {
    for (const name of Object.keys(workerTargets) as Array<keyof typeof workerTargets>) {
      const entry = worker(name)
      const bindings = [{ type: "secret_text", name: "TOKEN", text: "[secret]" }]
      const detailedDiff = {
        contentSha256: { diffKind: "update", inputDiff: false },
        annotations: { diffKind: "add", inputDiff: false },
        placement: { diffKind: "add", inputDiff: false },
        tailConsumers: { diffKind: "add", inputDiff: false },
      }
      const preview = {
        ...entry,
        diffs: Object.keys(detailedDiff),
        detailedDiff,
        old: { ...entry.old, inputs: { ...entry.old!.inputs, bindings } },
        new: { ...entry.new, inputs: { ...entry.new!.inputs, bindings } },
      }
      expect(verifyUsageQueueDeploymentDiff([preview])).toEqual({ workerUpdates: 1, urlUpdates: 0 })
      rejects({ ...preview, detailedDiff: null })
      rejects({ ...preview, keys: ["placement"] })
      for (const key of ["annotations", "placement", "tailConsumers"]) {
        rejects({ ...preview, diffs: preview.diffs.filter((field) => field !== key) })
        for (const inputs of [{ [key]: null }, { [key]: { service: "different" } }]) {
          rejects({ ...preview, old: { ...preview.old, inputs: { ...preview.old.inputs, ...inputs } } })
          rejects({ ...preview, new: { ...preview.new, inputs: { ...preview.new.inputs, ...inputs } } })
          rejects({
            ...preview,
            old: { ...preview.old, inputs: { ...preview.old.inputs, ...inputs } },
            new: { ...preview.new, inputs: { ...preview.new.inputs, ...inputs } },
          })
        }
        for (const value of [
          { diffKind: "update", inputDiff: false },
          { diffKind: "add-replace", inputDiff: false },
          { diffKind: "add", inputDiff: true },
          { diffKind: "add" },
          { kind: "add", inputDiff: false },
          null,
        ])
          rejects({ ...preview, detailedDiff: { ...detailedDiff, [key]: value } })
        rejects({ ...preview, detailedDiff: { ...detailedDiff, [`${key}.private-child`]: { diffKind: "add" } } })
        rejects({ ...preview, diffs: [...preview.diffs, `${key}.private-child`] })
      }
      for (const key of ["id", "usageModel", "keepBindings", "limits", "bindings", "unknown"]) {
        rejects({ ...preview, diffs: [...preview.diffs, key] })
        rejects({ ...preview, detailedDiff: { ...detailedDiff, [key]: { diffKind: "add", inputDiff: false } } })
      }
      for (const diffKind of [
        "add-replace",
        "update-replace",
        "delete",
        "delete-replace",
        "unknown",
        ["update"],
        null,
        1,
      ]) {
        rejects({ ...preview, detailedDiff: { ...detailedDiff, contentSha256: { diffKind, inputDiff: false } } })
      }
    }
  })

  test("accepts minimal SST input proof while rejecting conflicting optional state metadata", () => {
    const minimal = worker("UsageQueueSubscriberFunctionScript", { minimalState: true })
    expect(verifyUsageQueueDeploymentDiff([minimal])).toEqual({ workerUpdates: 1, urlUpdates: 0 })
    rejects({ ...minimal, old: { ...minimal.old, urn: urnFor(workerType, "OtherScript") } })
  })

  test("compares optional state identity metadata symmetrically when present", () => {
    for (const field of [
      "id",
      "provider",
      "parent",
      "protect",
      "delete",
      "external",
      "retainOnDelete",
      "deletedWith",
      "aliases",
      "custom",
      "taint",
      "initErrors",
      "hideDiffs",
    ]) {
      rejects(worker("UsageQueueSubscriberFunctionScript", { oldStatePatch: { [field]: "old-value" } }))
      rejects(worker("UsageQueueSubscriberFunctionScript", { newStatePatch: { [field]: "new-value" } }))
      rejects(
        worker("UsageQueueSubscriberFunctionScript", {
          oldStatePatch: { [field]: "old-value" },
          newStatePatch: { [field]: "new-value" },
        }),
      )
    }
  })

  test("rejects destructive, replacement, out-of-scope, duplicate, and malformed changes", () => {
    rejects({ ...worker(), op: "delete" })
    rejects({ ...worker(), op: "create" })
    rejects({ ...worker(), op: "replace" })
    rejects(mutating("cloudflare:index/queue:Queue", "UsageQueueQueue", "update"))
    rejects(mutating("cloudflare:index/workersCronTrigger:WorkersCronTrigger", "UsageQueueHeartbeatTrigger", "update"))
    rejects(mutating("cloudflare:index/workersSecret:WorkersSecret", "UsageQueueSubscriberSecret", "update"))
    rejects(mutating("cloudflare:index/workersCustomDomain:WorkersCustomDomain", "UsageQueueDomain", "update"))
    rejects(mutating("cloudflare:index/workersKvNamespace:WorkersKvNamespace", "UsageQueueKv", "update"))
    rejects(mutating("cloudflare:index/d1Database:D1Database", "UsageQueueD1", "update"))
    rejects([worker(), worker()])
    rejects([{ ...worker(), type: "cloudflare:index/workerScript:WorkerScript" }])
    rejects([{ urn: "not-a-urn", type: workerType, op: "update" }])
    rejects(Array.from({ length: 2_001 }, () => same("sst:cloudflare:Worker", crypto.randomUUID())))
  })

  test("never leaks private values through thrown errors", () => {
    const entry = worker("UsageQueueSubscriberFunctionScript", {
      stablePatch: { bindings: [{ name: "SECRET", text: privateValue }] },
    })
    expect(() => verifyUsageQueueDeploymentDiff([entry])).toThrow(UsageQueueDeploymentGuardError)
    try {
      verifyUsageQueueDeploymentDiff([entry])
    } catch (error) {
      expect(String(error)).not.toContain(privateValue)
      expect(JSON.stringify(error)).not.toContain(privateValue)
      expect(error instanceof UsageQueueDeploymentGuardError ? error.reason : null).toBe(
        "changed-worker-bindings-or-settings",
      )
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "Usage queue deployment preview is not approved",
      )
    }
  })

  test("reports fixed failure reasons without changing approval decisions or revealing values", () => {
    const cases = [
      [worker("UsageQueueSubscriberFunctionScript", { omitOldState: true }), "missing-state"],
      [worker("UsageQueueSubscriberFunctionScript", { omitInputs: true }), "missing-state-inputs"],
      [worker("UsageQueueSubscriberFunctionScript", { opaque: true }), "opaque-worker-inputs"],
      [worker("UsageQueueSubscriberFunctionScript", { deleteInput: "contentFile" }), "missing-worker-content"],
      [worker("UsageQueueSubscriberFunctionScript", { newContentSha256: privateValue }), "invalid-worker-hash"],
      [worker("UsageQueueSubscriberFunctionScript", { newStatePatch: { id: privateValue } }), "changed-state-id"],
      [mutating("pulumi:providers:pulumi-nodejs", "private-provider", "update"), "unapproved-provider-configuration"],
    ] as const
    for (const [entry, reason] of cases) {
      expect(() => verifyUsageQueueDeploymentDiff([entry])).toThrow(UsageQueueDeploymentGuardError)
      try {
        verifyUsageQueueDeploymentDiff([entry])
      } catch (error) {
        expect(error instanceof UsageQueueDeploymentGuardError ? error.reason : null).toBe(reason)
        expect(JSON.stringify(error)).not.toContain(privateValue)
      }
    }
  })
})

function rejects(value: unknown) {
  expect(() => verifyUsageQueueDeploymentDiff(Array.isArray(value) ? value : [value])).toThrow(
    UsageQueueDeploymentGuardError,
  )
}

function worker(
  name: keyof typeof workerTargets = "UsageQueueSubscriberFunctionScript",
  options: {
    accountId?: string
    scriptName?: string
    newContentSha256?: string
    stablePatch?: Record<string, unknown>
    addInput?: [string, unknown]
    deleteInput?: string
    opaque?: boolean
    omitOldState?: boolean
    omitNewState?: boolean
    omitInputs?: boolean
    minimalState?: boolean
    oldStatePatch?: Record<string, unknown>
    newStatePatch?: Record<string, unknown>
  } = {},
) {
  const scriptName = options.scriptName ?? workerTargets[name] ?? "mongolgpt-dev-unknown"
  const urn = urnFor(workerType, name)
  const oldInputs = {
    accountId: options.accountId ?? accountId,
    scriptName,
    contentFile: "old-worker.js",
    contentSha256: oldHash,
    compatibilityDate: "2026-09-01",
    bindings: [{ type: "plain_text", name: "ENV", text: "dev" }],
    __provider: "provider-ref",
  } as Record<string, unknown>
  const newInputs: Record<string, unknown> = {
    ...oldInputs,
    contentFile: "new-worker.js",
    contentSha256: options.newContentSha256 ?? newHash,
    ...options.stablePatch,
  }
  if (options.addInput) newInputs[options.addInput[0]] = options.addInput[1]
  if (options.deleteInput) delete newInputs[options.deleteInput]
  if (options.opaque) newInputs.bindings = [{ type: "plain_text", value: { __pulumiUnknown: true } }]

  return {
    urn,
    type: workerType,
    op: "update",
    detailedDiff: { "bindings.SECRET": { diffKind: "ignored", value: privateValue } },
    old: options.omitOldState
      ? undefined
      : state(urn, workerType, options.omitInputs ? undefined : oldInputs, options.minimalState, options.oldStatePatch),
    new: options.omitNewState
      ? undefined
      : state(urn, workerType, options.omitInputs ? undefined : newInputs, options.minimalState, options.newStatePatch),
  }
}

function url(
  name: keyof typeof urlTargets,
  options: {
    stablePatch?: Record<string, unknown>
    oldInputPatch?: Record<string, unknown>
    addInput?: [string, unknown]
    deleteInput?: string
    newEtag?: string
    opaque?: boolean
    oldStatePatch?: Record<string, unknown>
    newStatePatch?: Record<string, unknown>
  } = {},
) {
  const urn = urnFor(urlType, name)
  const oldInputs = {
    accountId,
    scriptName: urlTargets[name],
    enabled: true,
    etag: "old-etag",
    ...options.oldInputPatch,
  } as Record<string, unknown>
  const newInputs: Record<string, unknown> = {
    ...oldInputs,
    etag: options.newEtag ?? "new-etag",
    ...options.stablePatch,
  }
  if (options.addInput) newInputs[options.addInput[0]] = options.addInput[1]
  if (options.deleteInput) delete newInputs[options.deleteInput]
  if (options.opaque) newInputs.etag = "[unknown]"
  return {
    urn,
    type: urlType,
    op: "update",
    old: state(urn, urlType, oldInputs, false, options.oldStatePatch),
    new: state(urn, urlType, newInputs, false, options.newStatePatch),
  }
}

function stack() {
  return { urn: urnFor("pulumi:pulumi:Stack", "mongolgpt-dev"), type: "pulumi:pulumi:Stack", op: "update" }
}

function heartbeatLink() {
  const type = "sst:sst:LinkRef"
  const urn = urnFor(type, "UsageQueueHeartbeatHandlerLinkRef")
  const include = [
    {
      type: "cloudflare.binding",
      binding: "serviceBindings",
      properties: { service: "mongolgpt-dev-usagequeueheartbeathandlerscript" },
    },
  ]
  return {
    urn,
    type,
    op: "update",
    old: { urn, type, custom: false, inputs: { properties: {}, include } },
    new: { urn, type, custom: false, inputs: { properties: { url: unknownString }, include } },
  }
}

function same(type: string, name: string) {
  return { urn: urnFor(type, name), type, op: "same" }
}

function mutating(type: string, name: string, op: string) {
  return {
    urn: urnFor(type, name),
    type,
    op,
    old: state(urnFor(type, name), type, {}),
    new: state(urnFor(type, name), type, {}),
  }
}

function urnFor(type: string, name: string) {
  return `urn:pulumi:dev::mongolgpt::${type}::${name}`
}

function state(
  urn: string,
  type: string,
  inputs: Record<string, unknown> | undefined,
  minimal = false,
  patch: Record<string, unknown> = {},
) {
  if (minimal) return { inputs, ...patch }
  return { urn, type, id: `${type}::id`, provider: "provider-ref", inputs, ...patch }
}
