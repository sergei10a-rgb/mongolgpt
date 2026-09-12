import { isDeepStrictEqual } from "node:util"

const stack = "urn:pulumi:dev::mongolgpt"
const stackName = "mongolgpt-dev"
const accountId = "cc97ad90bfaf8a1da5de612eef2658f5"
const workerType = "cloudflare:index/workersScript:WorkersScript"
const workerUrlType = "pulumi-nodejs:dynamic:Resource"
const linkType = "sst:sst:LinkRef"
const heartbeatLinkName = "UsageQueueHeartbeatHandlerLinkRef"
const unknownString = "04da6b54-80e4-46f7-96ec-b56ff0331ba9"
const maximumEntries = 2_000

const workers = new Map([
  [
    "UsageQueueSubscriberFunctionScript",
    {
      scriptName: "mongolgpt-dev-usagequeuesubscriberfunctionscript",
      urlName: "UsageQueueSubscriberFunctionUrl.sst.cloudflare.WorkerUrl",
    },
  ],
  [
    "UsageQueueHeartbeatHandlerScript",
    {
      scriptName: "mongolgpt-dev-usagequeueheartbeathandlerscript",
      urlName: "UsageQueueHeartbeatHandlerUrl.sst.cloudflare.WorkerUrl",
    },
  ],
])

const workerUrls = new Map([...workers.values()].map((value) => [value.urlName, value.scriptName]))
const allowedOperations = new Set(["same", "update"])
const hashPattern = /^[a-f0-9]{64}$/i
// Public Pulumi serialization marker, not a credential.
const pulumiSignatureProperty = "4dabf18193072939515e22adb298388d"
const pulumiHiddenValueSignature = "1b47061264138c4ac30d75fd1eb44270"
const comparableStateFields = [
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
] as const

type RejectionReason =
  | "unapproved-resource"
  | "invalid-preview"
  | "invalid-entry"
  | "wrong-resource-scope"
  | "duplicate-resource"
  | "changed-link-binding"
  | "unapproved-link-properties"
  | "opaque-worker-inputs"
  | "unproved-worker-secret-bindings"
  | "wrong-worker-account"
  | "wrong-worker-name"
  | "missing-worker-content"
  | "invalid-worker-hash"
  | "changed-worker-bindings-or-settings"
  | "wrong-url-account"
  | "wrong-url-worker"
  | "changed-url-enabled"
  | "invalid-url-etag"
  | "unchanged-url-etag"
  | "opaque-url-inputs"
  | "changed-url-settings"
  | "missing-state"
  | "conflicting-state-identity"
  | "missing-state-inputs"
  | `opaque-state-${(typeof comparableStateFields)[number]}`
  | `changed-state-${(typeof comparableStateFields)[number]}`

export class UsageQueueDeploymentGuardError extends Error {
  constructor(readonly reason: RejectionReason = "unapproved-resource") {
    super("Usage queue deployment preview is not approved")
    this.name = "UsageQueueDeploymentGuardError"
  }
}

export interface UsageQueueDeploymentGuardSummary {
  workerUpdates: number
  urlUpdates: number
}

export function verifyUsageQueueDeploymentDiff(value: unknown): UsageQueueDeploymentGuardSummary {
  if (!Array.isArray(value) || value.length > maximumEntries) reject("invalid-preview")

  const seen = new Map<string, Record<string, unknown>>()
  const repeatedLinks = new Set<string>()
  let workerUpdates = 0
  let urlUpdates = 0

  for (const raw of value) {
    const entry = record(raw)
    const urn = text(entry?.urn)
    const type = text(entry?.type)
    const op = text(entry?.op)
    if (!entry || !urn || !type || !op || !allowedOperations.has(op)) reject("invalid-entry")

    const parsed = parseUrn(urn)
    if (parsed.stack !== stack || parsed.type.split("$").at(-1) !== type || parsed.name.length === 0)
      reject("wrong-resource-scope")
    const previous = seen.get(urn)
    if (type === linkType && parsed.type === linkType && parsed.name === heartbeatLinkName && op === "update") {
      assertHeartbeatLinkUpdate(entry, urn, type)
      // Pulumi emits a second component event when registerOutputs resolves.
      // Only its outputs may differ; inputs and all resource identity must agree.
      if (previous) {
        if (previous.op !== "update" || repeatedLinks.has(urn)) reject("duplicate-resource")
        for (const key of ["old", "new"]) {
          if (!isDeepStrictEqual(omit(record(previous[key])!, ["outputs"]), omit(record(entry[key])!, ["outputs"])))
            reject("duplicate-resource")
        }
        repeatedLinks.add(urn)
      }
      seen.set(urn, entry)
      continue
    }
    if (previous) reject("duplicate-resource")
    seen.set(urn, entry)

    if (op === "same") continue

    if (type === "pulumi:pulumi:Stack" && parsed.name === stackName && parsed.type === type) continue

    const worker = workers.get(parsed.name)
    if (type === workerType && worker) {
      assertWorkerUpdate(entry, urn, type, worker.scriptName)
      workerUpdates += 1
      continue
    }

    const urlScriptName = workerUrls.get(parsed.name)
    if (type === workerUrlType && urlScriptName) {
      assertWorkerUrlUpdate(entry, urn, type, urlScriptName)
      urlUpdates += 1
      continue
    }

    reject()
  }

  return { workerUpdates, urlUpdates }
}

function assertHeartbeatLinkUpdate(entry: Record<string, unknown>, urn: string, type: string) {
  const { oldInputs, newInputs } = stateInputs(entry, urn, type)
  if (record(entry.old)?.custom === true || record(entry.new)?.custom === true) reject("unapproved-link-properties")
  if (entry.keys !== undefined && (!Array.isArray(entry.keys) || entry.keys.length !== 0))
    reject("unapproved-link-properties")
  const oldProperties = record(oldInputs.properties)
  const newProperties = record(newInputs.properties)
  if (!oldProperties || !newProperties) reject("unapproved-link-properties")
  if (Object.keys(oldProperties).some((key) => key !== "url")) reject("unapproved-link-properties")
  if (!isDeepStrictEqual(newProperties, { url: unknownString })) reject("unapproved-link-properties")
  if (hasOpaqueValue(oldProperties)) reject("unapproved-link-properties")
  const include = [
    {
      type: "cloudflare.binding",
      binding: "serviceBindings",
      properties: { service: "mongolgpt-dev-usagequeueheartbeathandlerscript" },
    },
  ]
  if (!isDeepStrictEqual(oldInputs.include, include) || !isDeepStrictEqual(newInputs.include, include))
    reject("changed-link-binding")
  if (
    !isDeepStrictEqual(omit(oldInputs, ["properties"]), { include }) ||
    !isDeepStrictEqual(omit(newInputs, ["properties"]), { include })
  )
    reject("unapproved-link-properties")
}

function assertWorkerUpdate(entry: Record<string, unknown>, urn: string, type: string, expectedScriptName: string) {
  const { oldInputs, newInputs } = stateInputs(entry, urn, type)
  if (hasOpaqueValue(omit(oldInputs, ["bindings"])) || hasOpaqueValue(omit(newInputs, ["bindings"])))
    reject("opaque-worker-inputs")
  if (hasOpaqueValue(oldInputs.bindings) || hasOpaqueValue(newInputs.bindings)) {
    // Pulumi carries provider-reported changed keys separately from redacted states.
    // Equal masks alone cannot prove that a binding has not changed.
    if (!isResolvedWithSecretRedaction(oldInputs.bindings) || !isResolvedWithSecretRedaction(newInputs.bindings))
      reject("opaque-worker-inputs")
    if (
      !Array.isArray(entry.diffs) ||
      !entry.diffs.includes("contentSha256") ||
      entry.diffs.some((key) => key !== "contentSha256" && key !== "contentFile")
    )
      reject("unproved-worker-secret-bindings")
    if (entry.detailedDiff !== undefined && entry.detailedDiff !== null) {
      const detailed = record(entry.detailedDiff)
      if (!detailed || Object.keys(detailed).some((key) => key !== "contentSha256" && key !== "contentFile"))
        reject("unproved-worker-secret-bindings")
    }
    if (entry.keys !== undefined && (!Array.isArray(entry.keys) || entry.keys.length !== 0))
      reject("unproved-worker-secret-bindings")
  }
  if (oldInputs.accountId !== accountId || newInputs.accountId !== accountId) reject("wrong-worker-account")
  if (oldInputs.scriptName !== expectedScriptName || newInputs.scriptName !== expectedScriptName)
    reject("wrong-worker-name")

  const oldContentFile = text(oldInputs.contentFile)
  const newContentFile = text(newInputs.contentFile)
  const oldHash = text(oldInputs.contentSha256)
  const newHash = text(newInputs.contentSha256)
  if (!oldContentFile || !newContentFile || !oldHash || !newHash) reject("missing-worker-content")
  if (!hashPattern.test(newHash) || oldHash === newHash) reject("invalid-worker-hash")

  const oldStable = omit(oldInputs, ["contentFile", "contentSha256"])
  const newStable = omit(newInputs, ["contentFile", "contentSha256"])
  if (!isDeepStrictEqual(oldStable, newStable)) reject("changed-worker-bindings-or-settings")
}

function isResolvedWithSecretRedaction(value: unknown): boolean {
  if (typeof value === "string") return !value.includes("[unknown]") && value !== unknownString
  if (Array.isArray(value)) return value.every(isResolvedWithSecretRedaction)
  const item = record(value)
  if (!item) return true
  const keys = Object.keys(item)
  if (Object.hasOwn(item, "__pulumiUnknown")) return false
  if (keys.length === 1 && ["ciphertext", "secure"].includes(keys[0])) return false
  if (Object.hasOwn(item, pulumiSignatureProperty)) {
    return (
      item[pulumiSignatureProperty] === pulumiHiddenValueSignature &&
      Object.hasOwn(item, "value") &&
      keys.length === 2 &&
      isResolvedWithSecretRedaction(item.value)
    )
  }
  return Object.values(item).every(isResolvedWithSecretRedaction)
}

function assertWorkerUrlUpdate(entry: Record<string, unknown>, urn: string, type: string, expectedScriptName: string) {
  const { oldInputs, newInputs } = stateInputs(entry, urn, type)
  if (oldInputs.accountId !== accountId || newInputs.accountId !== accountId) reject("wrong-url-account")
  if (oldInputs.scriptName !== expectedScriptName || newInputs.scriptName !== expectedScriptName)
    reject("wrong-url-worker")
  if (typeof oldInputs.enabled !== "boolean" || oldInputs.enabled !== newInputs.enabled) reject("changed-url-enabled")
  if (!etag(oldInputs.etag) || !etag(newInputs.etag)) reject("invalid-url-etag")
  if (oldInputs.etag === newInputs.etag) reject("unchanged-url-etag")

  const oldStable = omit(oldInputs, ["etag"])
  const newStable = omit(newInputs, ["etag"])
  if (hasOpaqueValue(oldStable) || hasOpaqueValue(newStable)) reject("opaque-url-inputs")
  if (!isDeepStrictEqual(oldStable, newStable)) reject("changed-url-settings")
}

function stateInputs(entry: Record<string, unknown>, urn: string, type: string) {
  // SST 4.17.1 emits Pulumi 3.215.0 StepEventMetadata verbatim as old/new.
  const oldState = record(entry.old)
  const newState = record(entry.new)
  if (!oldState || !newState) reject("missing-state")
  if (oldState.urn !== undefined && oldState.urn !== urn) reject("conflicting-state-identity")
  if (newState.urn !== undefined && newState.urn !== urn) reject("conflicting-state-identity")
  if (oldState.type !== undefined && oldState.type !== type) reject("conflicting-state-identity")
  if (newState.type !== undefined && newState.type !== type) reject("conflicting-state-identity")
  for (const key of comparableStateFields) {
    if (hasOpaqueValue(oldState[key]) || hasOpaqueValue(newState[key])) reject(`opaque-state-${key}`)
    if (!isDeepStrictEqual(oldState[key], newState[key])) reject(`changed-state-${key}`)
  }

  const oldInputs = record(oldState.inputs)
  const newInputs = record(newState.inputs)
  if (!oldInputs || !newInputs) reject("missing-state-inputs")
  return { oldInputs, newInputs }
}

function parseUrn(urn: string) {
  const parts = urn.split("::")
  const prefix = parts.slice(0, 2).join("::")
  const type = parts.at(-2)
  const name = parts.at(-1)
  if (parts.length !== 4 || !type || !name) reject("wrong-resource-scope")
  return { stack: prefix, type, name }
}

function hasOpaqueValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("[secret]") || value.includes("[unknown]") || value === unknownString
  }
  if (Array.isArray(value)) return value.some(hasOpaqueValue)
  const item = record(value)
  if (!item) return false
  const keys = Object.keys(item)
  if (Object.hasOwn(item, pulumiSignatureProperty) || Object.hasOwn(item, "__pulumiUnknown")) return true
  if (keys.length === 1 && ["ciphertext", "secure"].includes(keys[0])) return true
  return Object.values(item).some(hasOpaqueValue)
}

function omit(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function etag(value: unknown) {
  const result = text(value)
  if (!result || result.includes("[secret]") || result.includes("[unknown]")) return undefined
  return result
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function reject(reason?: RejectionReason): never {
  throw new UsageQueueDeploymentGuardError(reason)
}
