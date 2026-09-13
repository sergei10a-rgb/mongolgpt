import { isDeepStrictEqual } from "node:util"

// Resource shape: local .sst/platform SST cloudflare/ssr-site.ts, worker.ts,
// base/base-ssr-site.ts and @pulumi/cloudflare WorkersScriptArgs (6.15.0).
// This checks resource scope, NOT source provenance. The caller must separately
// pin deployed 9f4f5757eedc1bb02eb95160bdaa87e04ec59dc5 plus the six UI files
// from 41d58f4dbc8c9b88cdf19e22745b126ce3f54235 before producing the diff.
const prefix = "urn:pulumi:dev::mongolgpt::"
const siteType = "sst:cloudflare:SolidStart"
const workerType = "sst:cloudflare:Worker"
const scriptType = "cloudflare:index/workersScript:WorkersScript"
const localType = "command:local:Command"
const dynamicType = "pulumi-nodejs:dynamic:Resource"
const stackUrn = `${prefix}pulumi:pulumi:Stack::mongolgpt-dev`
const siteUrn = `${prefix}${siteType}::Console`
const workerUrn = `${prefix}${siteType}$${workerType}::ConsoleWorker`
const scriptUrn = `${prefix}${siteType}$${workerType}$${scriptType}::ConsoleWorkerScript`
const builderUrn = `${prefix}${siteType}$${localType}::ConsoleBuilder`
const urlUrn = `${prefix}${siteType}$${workerType}$${dynamicType}::ConsoleWorkerUrl.sst.cloudflare.WorkerUrl`
const accountId = "cc97ad90bfaf8a1da5de612eef2658f5"
const scriptName = "mongolgpt-dev-consoleworkerscript"
const unknown = "04da6b54-80e4-46f7-96ec-b56ff0331ba9"
const hash = /^[a-f0-9]{64}$/i
const eventFields = ["op", "urn", "type", "old", "new", "keys", "diffs", "detailedDiff", "logical", "provider"]
const stateFields = [
  "type",
  "urn",
  "custom",
  "delete",
  "id",
  "parent",
  "protect",
  "taint",
  "retainOnDelete",
  "inputs",
  "outputs",
  "provider",
  "initErrors",
]
const workerInputs = [
  "accountId",
  "annotations",
  "assets",
  "bindings",
  "bodyPart",
  "compatibilityDate",
  "compatibilityFlags",
  "content",
  "contentFile",
  "contentSha256",
  "contentType",
  "keepAssets",
  "keepBindings",
  "limits",
  "logpush",
  "mainModule",
  "migrations",
  "observability",
  "placement",
  "scriptName",
  "tailConsumers",
  "usageModel",
]
const computed = [
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
]
const optionalComputed = ["annotations", "placement", "tailConsumers"]
type Reason =
  | "invalid-preview"
  | "invalid-entry"
  | "unapproved-resource"
  | "unapproved-operation"
  | "invalid-state"
  | "changed-state"
  | "opaque-protected-value"
  | "changed-protected-value"
  | "unknown-field"
  | "invalid-code"
  | "invalid-diff-metadata"
  | "incomplete-plan"
  | "duplicate-resource"

export class ConsoleUiDeploymentGuardError extends Error {
  constructor(readonly reason: Reason = "invalid-preview") {
    super("Dev Console UI deployment preview is not approved")
    this.name = "ConsoleUiDeploymentGuardError"
  }
}

export function verifyConsoleUiDeploymentDiff(value: unknown) {
  try {
    return verify(value)
  } catch (error) {
    if (error instanceof ConsoleUiDeploymentGuardError) throw error
    // Never expose parsing errors, property paths, URNs, or input values.
    throw new ConsoleUiDeploymentGuardError()
  }
}

export function describeConsoleUiDeploymentDiff(value: unknown) {
  if (!Array.isArray(value) || value.length > 2_000) return { validArray: false }
  const resources = new Map([
    [scriptUrn, "console-worker"],
    [builderUrn, "local-builder"],
    [urlUrn, "worker-url"],
    [siteUrn, "console-component"],
    [workerUrn, "worker-component"],
    [stackUrn, "stack"],
  ])
  const operations = [
    "same",
    "update",
    "create",
    "delete",
    "replace",
    "create-replacement",
    "delete-replaced",
    "read",
    "refresh",
    "read-replacement",
    "discard",
    "remove-pending-replace",
  ]
  const keys = [
    ...workerInputs,
    ...computed,
    "create",
    "update",
    "dir",
    "environment",
    "triggers",
    "__provider",
    "enabled",
    "previewEnabled",
    "assets.assetManifestSha256",
    "assets.directory",
    "assets.jwt",
  ]
  return {
    entries: value.slice(0, 100).map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { resource: "invalid" }
      const entry = raw as Record<string, unknown>
      const before =
        entry.old && typeof entry.old === "object" ? (entry.old as Record<string, unknown>).inputs : undefined
      const after =
        entry.new && typeof entry.new === "object" ? (entry.new as Record<string, unknown>).inputs : undefined
      const changedInputs =
        before && after && typeof before === "object" && typeof after === "object"
          ? keys.filter(
              (key) =>
                !isDeepStrictEqual((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key]),
            )
          : []
      return {
        resource: typeof entry.urn === "string" ? (resources.get(entry.urn) ?? "other") : "invalid",
        operation: typeof entry.op === "string" && operations.includes(entry.op) ? entry.op : "unknown",
        changedInputs,
        states: [entry.old, entry.new].map((raw) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { present: false }
          const state = raw as Record<string, unknown>
          const inputs = state.inputs
          return {
            present: true,
            unknownFields: Object.keys(state).filter((key) => !stateFields.includes(key)).length,
            deleted: state.delete === true,
            inputs: !inputs || typeof inputs !== "object" ? typeof inputs : Array.isArray(inputs) ? "array" : "object",
            codeHash: redacted((inputs as Record<string, unknown> | undefined)?.contentSha256)
              ? "redacted"
              : typeof (inputs as Record<string, unknown> | undefined)?.contentSha256 === "string"
                ? hash.test((inputs as Record<string, string>).contentSha256)
                  ? "hash"
                  : "not-hash"
                : "missing",
            codeFile: redacted((inputs as Record<string, unknown> | undefined)?.contentFile)
              ? "redacted"
              : typeof (inputs as Record<string, unknown> | undefined)?.contentFile,
            assets: redacted((inputs as Record<string, unknown> | undefined)?.assets) ? "redacted" : "visible",
          }
        }),
        validation: diagnosticReason(
          value.filter((item) => item && typeof item === "object" && item.urn === entry.urn),
        ),
        environmentChanges:
          entry.urn === builderUrn && before && after && typeof before === "object" && typeof after === "object"
            ? environmentChanges(before as Record<string, unknown>, after as Record<string, unknown>)
            : undefined,
        replacementKeys: Array.isArray(entry.keys)
          ? entry.keys.map((key) => (key === "triggers" || key === "triggers[0]" ? key : "other"))
          : [],
        differences: Array.isArray(entry.diffs)
          ? [...new Set(entry.diffs.map((key) => (typeof key === "string" && keys.includes(key) ? key : "other")))]
          : [],
        details:
          entry.detailedDiff && typeof entry.detailedDiff === "object" && !Array.isArray(entry.detailedDiff)
            ? Object.entries(entry.detailedDiff)
                .slice(0, 100)
                .map(([key, raw]) => {
                  const detail = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
                  return {
                    field: keys.includes(key)
                      ? key
                      : key === "triggers[0]"
                        ? "triggers[0]"
                        : key.startsWith("environment.") || key.startsWith("environment[")
                          ? "environment-entry"
                          : "other",
                    kind:
                      typeof detail.diffKind === "string" &&
                      ["add", "delete", "update", "add-replace", "delete-replace", "update-replace"].includes(
                        detail.diffKind,
                      )
                        ? detail.diffKind
                        : "unknown",
                    input: detail.inputDiff === true,
                  }
                })
            : [],
      }
    }),
  }
}

function diagnosticReason(value: unknown) {
  try {
    verify(value, false)
    return "accepted-resource"
  } catch (error) {
    return error instanceof ConsoleUiDeploymentGuardError ? error.reason : "invalid-preview"
  }
}

function builderReplacements(value: unknown[]) {
  const entries = value.map(object)
  const phases = entries.filter((entry) => entry.urn === builderUrn)
  if (!phases.some((entry) => ["create-replacement", "delete-replaced"].includes(String(entry.op)))) return entries
  if (phases.length !== 3 || phases.map((entry) => entry.op).join(",") !== "create-replacement,replace,delete-replaced")
    reject("invalid-diff-metadata")
  const [create, replace, remove] = phases
  for (const phase of phases) fields(phase, eventFields)
  if (!isDeepStrictEqual(omit(create, ["op", "logical"]), omit(replace, ["op", "logical"]))) reject("changed-state")
  if (phases.some((entry) => entry.logical !== undefined && typeof entry.logical !== "boolean")) reject("invalid-entry")
  if (remove.new != null || remove.type !== replace.type || remove.provider !== replace.provider)
    reject("invalid-state")
  const old = object(replace.old)
  const removed = object(remove.old)
  if (removed.delete !== undefined && typeof removed.delete !== "boolean") reject("invalid-state")
  if (!isDeepStrictEqual(omit(old, ["delete"]), omit(removed, ["delete"]))) reject("changed-state")
  metadata(remove, [])
  // Only the existing, delete-command-free local builder has a three-step lifecycle.
  // The retained replace event still passes all environment, command and trigger checks.
  const next = object(replace.new)
  if (next.delete !== undefined && next.delete !== false) reject("invalid-state")
  return entries
    .filter((entry) => entry !== create && entry !== remove)
    .map((entry) =>
      entry === replace
        ? { ...entry, old: next.delete === undefined ? omit(old, ["delete"]) : { ...old, delete: next.delete } }
        : entry,
    )
}

function verify(value: unknown, complete = true) {
  if (!Array.isArray(value) || !value.length || value.length > 2_000) reject("invalid-preview")
  const seen = new Set<string>()
  const summary = { workerUpdates: 0, builderUpdates: 0, urlUpdates: 0 }
  for (const raw of builderReplacements(value)) {
    const entry = object(raw)
    fields(entry, eventFields)
    const urn = entry.urn
    if (
      typeof urn !== "string" ||
      typeof entry.type !== "string" ||
      (entry.provider !== undefined && typeof entry.provider !== "string")
    )
      reject("invalid-entry")
    const parts = urn.split("::")
    if (parts.length !== 4 || !urn.startsWith(prefix) || !parts[3] || parts[2].split("$").at(-1) !== entry.type)
      reject("invalid-entry")
    if (seen.has(urn)) reject("duplicate-resource")
    seen.add(urn)
    if (entry.logical !== undefined && typeof entry.logical !== "boolean") reject("invalid-entry")
    const localReplacement = urn === builderUrn && entry.op === "replace"
    if (entry.op !== "same" && entry.op !== "update" && !localReplacement) reject("unapproved-operation")
    const old = object(entry.old)
    const next = object(entry.new)
    for (const state of [old, next]) {
      fields(state, stateFields)
      if (
        (state.urn !== undefined && state.urn !== urn) ||
        (state.type !== undefined && state.type !== entry.type) ||
        (state.id !== undefined && typeof state.id !== "string") ||
        (state.parent !== undefined && typeof state.parent !== "string") ||
        (state.provider !== undefined &&
          (typeof state.provider !== "string" || (entry.provider !== undefined && state.provider !== entry.provider)))
      )
        reject("invalid-state")
      for (const key of ["custom", "delete", "protect", "taint", "retainOnDelete"]) {
        if (state[key] !== undefined && typeof state[key] !== "boolean") reject("invalid-state")
      }
      if (
        state.delete ||
        state.taint ||
        (state.initErrors !== undefined && (!Array.isArray(state.initErrors) || state.initErrors.length))
      )
        reject("invalid-state")
      object(state.inputs)
      if (state.outputs !== undefined) object(state.outputs)
    }
    equal(
      omit(old, ["inputs", "outputs", ...(localReplacement ? ["id"] : [])]),
      omit(next, ["inputs", "outputs", ...(localReplacement ? ["id"] : [])]),
    )
    const before = object(old.inputs)
    const after = object(next.inputs)
    if (entry.op === "same") {
      metadata(entry, [])
      equal(before, after)
      equal(old.outputs, next.outputs)
      continue
    }
    if (![scriptUrn, builderUrn, urlUrn, stackUrn, siteUrn, workerUrn].includes(urn)) reject("unapproved-resource")
    if (urn === scriptUrn || urn === builderUrn || urn === urlUrn) {
      if (old.custom !== true || next.custom !== true || !old.id || (!localReplacement && !next.id))
        reject("invalid-state")
      if (old.parent !== (urn === builderUrn ? siteUrn : workerUrn)) reject("invalid-state")
    }
    if (urn === scriptUrn) {
      fields(before, workerInputs)
      fields(after, workerInputs)
      for (const inputs of [before, after]) {
        if (inputs.accountId !== accountId || inputs.scriptName !== scriptName || inputs.mainModule !== "placeholder")
          reject("changed-protected-value")
        if (
          (!Array.isArray(inputs.bindings) && !(opaque(inputs.bindings) && knownRedactions(inputs.bindings))) ||
          typeof inputs.compatibilityDate !== "string" ||
          !Array.isArray(inputs.compatibilityFlags)
        )
          reject("invalid-state")
        if (
          (!redacted(inputs.contentFile) && (typeof inputs.contentFile !== "string" || !inputs.contentFile.trim())) ||
          (!redacted(inputs.contentSha256) &&
            (typeof inputs.contentSha256 !== "string" || !hash.test(inputs.contentSha256)))
        )
          reject("invalid-code")
        if (opaque(inputs.contentFile) && !redacted(inputs.contentFile)) reject("invalid-code")
        if (redacted(inputs.assets)) continue
        const assets = object(inputs.assets)
        fields(assets, ["directory", "assetManifestSha256", "config", "jwt"])
        if (typeof assets.directory !== "string" || !assets.directory.trim() || opaque(assets.directory))
          reject("invalid-code")
        if (
          assets.assetManifestSha256 !== undefined &&
          (typeof assets.assetManifestSha256 !== "string" || !hash.test(assets.assetManifestSha256))
        )
          reject("invalid-code")
        if (assets.config !== undefined)
          fields(object(assets.config), [
            "headers",
            "redirects",
            "htmlHandling",
            "notFoundHandling",
            "runWorkerFirst",
            "serveDirectly",
          ])
      }
      equal(
        omit(before, ["contentFile", "contentSha256", "assets", "bindings"]),
        omit(after, ["contentFile", "contentSha256", "assets", "bindings"]),
      )
      if (!isDeepStrictEqual(before.bindings, after.bindings)) reject("changed-protected-value")
      const codeFields = ["contentFile", "contentSha256", "assets", "assets.directory", "assets.assetManifestSha256"]
      const detailed = entry.detailedDiff === undefined || entry.detailedDiff === null ? {} : object(entry.detailedDiff)
      const maskedCode = [before.contentFile, after.contentFile, before.contentSha256, after.contentSha256].some(
        redacted,
      )
      const hashDiff = detailed.contentSha256
      const provedCodeChange =
        Array.isArray(entry.diffs) &&
        entry.diffs.includes("contentSha256") &&
        hashDiff !== null &&
        typeof hashDiff === "object" &&
        !Array.isArray(hashDiff) &&
        object(hashDiff).diffKind === "update" &&
        object(hashDiff).inputDiff === false
      if (maskedCode && !provedCodeChange) reject("invalid-code")
      const maskedAssets = redacted(before.assets) || redacted(after.assets)
      if (
        maskedAssets &&
        (!redacted(before.assets) ||
          !redacted(after.assets) ||
          !isDeepStrictEqual(before.assets, after.assets) ||
          !provedCodeChange ||
          !Array.isArray(entry.diffs) ||
          (entry.diffs.includes("assets") && !Object.hasOwn(detailed, "assets.assetManifestSha256")) ||
          Object.hasOwn(detailed, "assets"))
      )
        reject("opaque-protected-value")
      // Same independently reported provider proof as usage-queue-deployment-guard.
      // Optional+Computed additions qualify only when unconfigured in BOTH inputs.
      const additions = optionalComputed.filter((key) => {
        const change = detailed[key]
        return (
          !Object.hasOwn(before, key) &&
          !Object.hasOwn(after, key) &&
          Array.isArray(entry.diffs) &&
          entry.diffs.includes(key) &&
          change !== null &&
          typeof change === "object" &&
          !Array.isArray(change) &&
          object(change).diffKind === "add" &&
          object(change).inputDiff === false
        )
      })
      if (opaque(before.bindings) || opaque(after.bindings)) {
        if (
          !knownRedactions(before.bindings) ||
          !knownRedactions(after.bindings) ||
          !Array.isArray(entry.diffs) ||
          !entry.diffs.includes("contentSha256") ||
          (!maskedCode && before.contentSha256 === after.contentSha256) ||
          entry.diffs.some((key) => !codeFields.includes(key) && !computed.includes(key) && !additions.includes(key))
        )
          reject("opaque-protected-value")
      }
      if (!maskedAssets) {
        equal(
          omit(object(before.assets), ["directory", "assetManifestSha256"]),
          omit(object(after.assets), ["directory", "assetManifestSha256"]),
        )
      }
      if (isDeepStrictEqual(before, after) && !(maskedCode && provedCodeChange)) reject("invalid-code")
      metadata(entry, codeFields, [...computed, ...additions])
      summary.workerUpdates++
    } else if (urn === builderUrn) {
      for (const inputs of [before, after]) {
        fields(inputs, ["create", "update", "dir", "environment", "triggers"])
        if (
          inputs.create !== "bun run build" ||
          inputs.update !== "bun run build" ||
          typeof inputs.dir !== "string" ||
          !/(?:^|[\\/])packages[\\/]console[\\/]app$/.test(inputs.dir)
        )
          reject("invalid-state")
        object(inputs.environment)
        if (
          !Array.isArray(inputs.triggers) ||
          inputs.triggers.length !== 1 ||
          typeof inputs.triggers[0] !== "string" ||
          !/^\d{13}$/.test(inputs.triggers[0])
        )
          reject("invalid-state")
      }
      equal(omit(before, ["triggers", "environment"]), omit(after, ["triggers", "environment"]))
      const oldEnv = object(before.environment)
      const newEnv = object(after.environment)
      const ephemeral = [...new Set([...Object.keys(oldEnv), ...Object.keys(newEnv)])].filter((key) => {
        if (
          !/^(GITHUB_|RUNNER_|ACTIONS_)/.test(key) &&
          ![
            "AUTH_UI_CONTROL",
            "AUTH_UI_ONLY",
            "PREVIEW_AUTH_ONLY",
            "MONGOLGPT_RELEASE_SHA",
            "PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW",
          ].includes(key)
        )
          return false
        for (const env of [oldEnv, newEnv]) {
          if (!Object.hasOwn(env, key)) continue
          const value = env[key]
          if (typeof value !== "string" || opaque(value)) reject("invalid-state")
          if (key === "MONGOLGPT_RELEASE_SHA" && !/^[a-f0-9]{40}$/i.test(value)) reject("invalid-state")
          if (["AUTH_UI_ONLY", "PREVIEW_AUTH_ONLY"].includes(key) && !["true", "false"].includes(value))
            reject("invalid-state")
          if (key === "PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW" && value !== "true") reject("invalid-state")
        }
        return true
      })
      const oldProtected = omit(oldEnv, ephemeral)
      const newProtected = omit(newEnv, ephemeral)
      if (!isDeepStrictEqual(oldProtected, newProtected)) reject("changed-protected-value")
      const masked = opaque(oldProtected) || opaque(newProtected)
      const environmentPaths = ephemeral.flatMap((key) => [`environment.${key}`, `environment[${JSON.stringify(key)}]`])
      if (masked) {
        if (
          !knownRedactions(oldProtected) ||
          !knownRedactions(newProtected) ||
          !Array.isArray(entry.diffs) ||
          !entry.diffs.some((key) => key === "triggers" || key === "triggers[0]") ||
          entry.diffs.some((key) => !["triggers", "triggers[0]", "environment", ...environmentPaths].includes(key))
        )
          reject("opaque-protected-value")
        if (
          entry.detailedDiff !== undefined &&
          entry.detailedDiff !== null &&
          Object.hasOwn(object(entry.detailedDiff), "environment")
        )
          reject("opaque-protected-value")
        // A root environment diff cannot prove masked app settings unchanged.
        if (entry.diffs.includes("environment") || !isDeepStrictEqual(oldEnv, newEnv)) {
          const details = object(entry.detailedDiff)
          if (
            !Object.keys(details).some((key) => environmentPaths.includes(key)) ||
            Object.keys(details).some(
              (key) => !environmentPaths.includes(key) && !["triggers", "triggers[0]"].includes(key),
            )
          )
            reject("opaque-protected-value")
        }
      }
      if (isDeepStrictEqual(before.triggers, after.triggers)) reject("invalid-code")
      metadata(entry, ["triggers", "triggers[0]", "environment", ...environmentPaths], [], localReplacement)
      summary.builderUpdates++
    } else if (urn === urlUrn) {
      for (const inputs of [before, after]) {
        fields(inputs, ["accountId", "scriptName", "enabled", "etag", "__provider", "url"])
        if (inputs.accountId !== accountId || inputs.scriptName !== scriptName || inputs.enabled !== true)
          reject("changed-protected-value")
      }
      equal(omit(before, ["etag"]), omit(after, ["etag"]))
      if (
        typeof before.etag !== "string" ||
        !before.etag ||
        opaque(before.etag) ||
        typeof after.etag !== "string" ||
        !after.etag ||
        after.etag === before.etag ||
        (opaque(after.etag) && after.etag !== unknown)
      )
        reject("invalid-code")
      metadata(entry, ["etag"])
      summary.urlUpdates++
    } else {
      // No broad stack-output exemption: local auto/run.ts only adds _protect.
      // Neither a changed URL nor an unknown UI-file output is approved here.
      equal(before, after)
      equal(old.outputs, next.outputs)
      metadata(entry, [])
      if (old.custom === true || next.custom === true) reject("invalid-state")
    }
  }
  if (complete && summary.workerUpdates !== 1) reject("incomplete-plan")
  return summary
}

function metadata(entry: Record<string, unknown>, allowed: string[], outputOnly: string[] = [], replacement = false) {
  if (
    entry.keys !== undefined &&
    (!Array.isArray(entry.keys) || entry.keys.some((key) => !replacement || !["triggers", "triggers[0]"].includes(key)))
  )
    reject("invalid-diff-metadata")
  if (replacement && (!Array.isArray(entry.keys) || entry.keys.length !== 1)) reject("invalid-diff-metadata")
  if (
    entry.diffs !== undefined &&
    (!Array.isArray(entry.diffs) ||
      entry.diffs.some((key) => typeof key !== "string" || (!allowed.includes(key) && !outputOnly.includes(key))))
  )
    reject("invalid-diff-metadata")
  if (entry.detailedDiff !== undefined && entry.detailedDiff !== null) {
    for (const [key, raw] of Object.entries(object(entry.detailedDiff))) {
      const diff = object(raw)
      fields(diff, ["diffKind", "inputDiff"])
      if (
        typeof diff.diffKind !== "string" ||
        typeof diff.inputDiff !== "boolean" ||
        ![
          "add",
          "delete",
          "update",
          ...(replacement && ["triggers", "triggers[0]"].includes(key) ? ["update-replace"] : []),
        ].includes(diff.diffKind) ||
        (!allowed.includes(key) && !(outputOnly.includes(key) && diff.inputDiff === false))
      )
        reject("invalid-diff-metadata")
    }
  }
}

function equal(before: unknown, after: unknown) {
  if (opaque(before) || opaque(after)) reject("opaque-protected-value")
  if (!isDeepStrictEqual(before, after)) reject("changed-protected-value")
}

function opaque(value: unknown): boolean {
  if (typeof value === "string") return value === unknown || value.includes("[secret]") || value.includes("[unknown]")
  if (Array.isArray(value)) return value.some(opaque)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, item]) =>
      ["4dabf18193072939515e22adb298388d", "__pulumiUnknown", "ciphertext", "secure"].includes(key) || opaque(item),
  )
}

function knownRedactions(value: unknown): boolean {
  if (typeof value === "string")
    return value !== unknown && !value.includes("[unknown]") && (!value.includes("[secret]") || value === "[secret]")
  if (Array.isArray(value)) return value.every(knownRedactions)
  if (!value || typeof value !== "object") return true
  const item = object(value)
  if (Object.hasOwn(item, "4dabf18193072939515e22adb298388d")) {
    return (
      Object.keys(item).length === 2 &&
      item["4dabf18193072939515e22adb298388d"] === "1b47061264138c4ac30d75fd1eb44270" &&
      item.ciphertext === "[secret]"
    )
  }
  if (["__pulumiUnknown", "ciphertext", "secure"].some((key) => Object.hasOwn(item, key))) return false
  return Object.values(item).every(knownRedactions)
}

function redacted(value: unknown) {
  return (
    value === "[secret]" ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "4dabf18193072939515e22adb298388d") &&
      knownRedactions(value))
  )
}

function environmentChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const old = before.environment
  const next = after.environment
  if (!old || !next || typeof old !== "object" || typeof next !== "object") return []
  return [...new Set([...Object.keys(old), ...Object.keys(next)])]
    .filter((key) => !isDeepStrictEqual((old as Record<string, unknown>)[key], (next as Record<string, unknown>)[key]))
    .map((key) =>
      /^(GITHUB_|RUNNER_|ACTIONS_)/.test(key)
        ? "ci-entry"
        : [
              "AUTH_UI_CONTROL",
              "AUTH_UI_ONLY",
              "PREVIEW_AUTH_ONLY",
              "MONGOLGPT_RELEASE_SHA",
              "PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW",
              "PATH",
              "HOME",
              "PWD",
              "SHLVL",
              "SHELL",
              "TMPDIR",
              "NODE_OPTIONS",
            ].includes(key)
          ? key
          : "other",
    )
}

function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    reject("invalid-state")
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject("unknown-field")
}

function omit(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function reject(reason: Reason): never {
  throw new ConsoleUiDeploymentGuardError(reason)
}
