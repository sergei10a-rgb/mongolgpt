import { isDeepStrictEqual } from "node:util"
import {
  UsageQueueDeploymentGuardError,
  usageQueueWorkerComputedFields,
  verifyUsageQueueDeploymentDiff,
} from "./usage-queue-deployment-guard"

const targets = ["UsageQueueSubscriber", "UsageQueueHeartbeat"] as const
const operations = new Set([
  "same",
  "create",
  "update",
  "delete",
  "replace",
  "create-replacement",
  "delete-replaced",
  "read",
  "refresh",
])
const fields = new Set([
  ...usageQueueWorkerComputedFields,
  // Remaining public WorkersScript 6.15.0 schema fields and the Pulumi resource ID.
  "annotations",
  "assets",
  "bodyPart",
  "contentType",
  "keepAssets",
  "keepBindings",
  "limits",
  "migrations",
  "placement",
  "tailConsumers",
  "usageModel",
  "id",
  "content",
  "contentFile",
  "contentSha256",
  "modules",
  "bindings",
  "textBindings",
  "queueBindings",
  "kvNamespaceBindings",
  "d1DatabaseBindings",
  "compatibilityDate",
  "compatibilityFlags",
  "scriptName",
  "accountId",
  "schedules",
  "settings",
  "queueId",
  "deadLetterQueue",
  "environment",
  "handler",
  "link",
  "version",
  "tags",
  "outputs",
  "url",
  "observability",
  "logpush",
  "mainModule",
  "enabled",
  "etag",
  "__provider",
  "properties",
  "include",
  "apiToken",
  "apiKey",
  "email",
  "pluginDownloadURL",
  "__internal",
  "cloudflare:version",
  "random:version",
])

// Pulumi 3.215.0 providers/registry.go reserves these engine metadata fields.
const internalFields = new Set(["name", "version", "pluginDownloadURL", "pluginChecksums", "parameterization"])
const pulumiSignatureProperty = "4dabf18193072939515e22adb298388d"
const pulumiHiddenValueSignature = "1b47061264138c4ac30d75fd1eb44270"
const pulumiAssetSignature = "c44067f5952c0a294b673a41bacd8c17"
const pulumiArchiveSignature = "0def7320c3a5731c473e5ecbe6d01bc7"
const pulumiResourceSignature = "5cf8f73096256a8f31e491e813e4eb8e"
const pulumiOutputSignature = "d0e6a833031e9bbcd3f4e8bde6ca49a4"

// Report only bounded deployment metadata, never state inputs, outputs, or code.
export function summarizeUsageQueueDeploymentDiff(value: unknown) {
  if (!Array.isArray(value) || value.length > 2_000) throw new Error("Invalid queue deployment diff")
  const seen = new Map<string, number>()
  const changes = value.map((raw, index) => {
    const entry = record(raw)
    if (!entry || typeof entry.urn !== "string" || typeof entry.type !== "string" || typeof entry.op !== "string") {
      throw new Error("Invalid queue deployment diff entry")
    }
    const urn = entry.urn.split("::")
    if (urn.length !== 4 || urn[0] !== "urn:pulumi:dev" || urn[1] !== "mongolgpt") {
      throw new Error("Queue deployment audit requires mongolgpt/dev")
    }
    if (urn[2].split("$").at(-1) !== entry.type || !operations.has(entry.op)) {
      throw new Error("Invalid queue deployment diff metadata")
    }
    const target = targets.find((name) => urn[3].startsWith(name)) ?? "outside-targets"
    const detail = record(entry.detailedDiff)
    const oldInputs = record(record(entry.old)?.inputs)
    const newInputs = record(record(entry.new)?.inputs)
    const sameResourceAs = seen.get(entry.urn) ?? null
    seen.set(entry.urn, index)
    const rejectionReason = rejectionReasonFor([entry])
    return {
      target,
      operation: entry.op,
      resource: resourceKind(entry.type, urn[3], target !== "outside-targets"),
      sameResourceAs,
      identicalPreviousEvent: sameResourceAs === null ? null : isDeepStrictEqual(value[sameResourceAs], entry),
      identicalPreviousStatesExceptOutputs:
        sameResourceAs === null
          ? null
          : ["old", "new"].every((key) =>
              isDeepStrictEqual(
                { ...record(record(value[sameResourceAs])?.[key]), outputs: undefined },
                { ...record(entry[key]), outputs: undefined },
              ),
            ),
      allowedIndividually: rejectionReason === null,
      rejectionReason,
      metadataEvidence: metadataEvidence(entry.type, oldInputs, newInputs),
      workerDiffEvidence:
        entry.type === "cloudflare:index/workersScript:WorkersScript"
          ? workerDiffEvidence(entry, oldInputs, newInputs)
          : null,
      opaqueInputFields: [
        ...new Set(
          [oldInputs, newInputs].flatMap((inputs) =>
            Object.entries(inputs ?? {})
              .filter(([, value]) => opaqueKinds(value).length > 0)
              .map(([key]) => (fields.has(key) ? key : "other")),
          ),
        ),
      ].sort(),
      opaqueInputKinds: [...new Set([oldInputs, newInputs].flatMap(opaqueKinds))].sort(),
      engineDiffAvailable: Array.isArray(entry.diffs),
      engineDiffFields: Array.isArray(entry.diffs)
        ? [...new Set(entry.diffs.map((key) => (typeof key === "string" && fields.has(key) ? key : "other")))].sort()
        : [],
      fields: [
        ...new Set(
          Object.keys(detail ?? {}).map((path) => {
            const root = path.split(/[.\[]/, 1)[0]
            return fields.has(root) ? root : "other"
          }),
        ),
      ].sort(),
      detailedDiffAvailable: detail !== undefined,
      inputComparisonAvailable: oldInputs !== undefined && newInputs !== undefined,
      changedInputFields:
        oldInputs && newInputs
          ? [
              ...new Set(
                [...Object.keys(oldInputs), ...Object.keys(newInputs)]
                  .filter((key) => !isDeepStrictEqual(oldInputs[key], newInputs[key]))
                  .map((key) => (fields.has(key) ? key : "other")),
              ),
            ].sort()
          : [],
    }
  })
  return { stage: "dev", targets, count: changes.length, previewRejectionReason: rejectionReasonFor(value), changes }
}

function workerDiffEvidence(
  entry: Record<string, unknown>,
  oldInputs: Record<string, unknown> | undefined,
  newInputs: Record<string, unknown> | undefined,
) {
  const diffs = Array.isArray(entry.diffs) ? entry.diffs : []
  const known = [...new Set(diffs.filter((key): key is string => typeof key === "string" && fields.has(key)))].sort()
  return {
    inputPresence: known.map((field) => ({
      field,
      old: oldInputs ? Object.hasOwn(oldInputs, field) : null,
      new: newInputs ? Object.hasOwn(newInputs, field) : null,
    })),
    unknownEngineFieldCount: diffs.filter((key) => typeof key !== "string" || !fields.has(key)).length,
    replacementMetadataKind: valueKind(entry.keys),
    replacementFields: Array.isArray(entry.keys)
      ? [...new Set(entry.keys.map((key) => (typeof key === "string" && fields.has(key) ? key : "other")))].sort()
      : [],
    detailedInputFields: [
      ...new Set(
        Object.entries(record(entry.detailedDiff) ?? {})
          .filter(([, value]) => record(value)?.inputDiff === true)
          .map(([path]) => {
            const root = path.split(/[.\[]/, 1)[0]
            return fields.has(root) ? root : "other"
          }),
      ),
    ].sort(),
  }
}

function metadataEvidence(
  type: string,
  oldInputs: Record<string, unknown> | undefined,
  newInputs: Record<string, unknown> | undefined,
) {
  if (!oldInputs || !newInputs) return null
  if (type === "pulumi:providers:pulumi-nodejs") {
    const oldInternal = record(oldInputs.__internal)
    const newInternal = record(newInputs.__internal)
    return {
      configurationChanges: [...new Set([...Object.keys(oldInputs), ...Object.keys(newInputs)])]
        .filter((key) => !isDeepStrictEqual(oldInputs[key], newInputs[key]))
        .map((key) => ({
          field: fields.has(key) ? key : "other",
          namespaced: key.includes(":"),
          oldKind: valueKind(oldInputs[key]),
          newKind: valueKind(newInputs[key]),
          oldVersion: version(key, oldInputs[key]),
          newVersion: version(key, newInputs[key]),
        })),
      emptyInternalMetadataAdded:
        !Object.hasOwn(oldInputs, "__internal") && newInternal !== undefined && Object.keys(newInternal).length === 0,
      changedInternalFields: [
        ...new Set(
          [...Object.keys(oldInternal ?? {}), ...Object.keys(newInternal ?? {})]
            .filter((key) => !isDeepStrictEqual(oldInternal?.[key], newInternal?.[key]))
            .map((key) => (internalFields.has(key) ? key : "other")),
        ),
      ].sort(),
    }
  }
  if (type !== "sst:sst:LinkRef") return null
  const oldProperties = record(oldInputs.properties)
  const newProperties = record(newInputs.properties)
  if (!oldProperties || !newProperties) return null
  return {
    onlyUrlPropertyChanged:
      isDeepStrictEqual(
        Object.fromEntries(Object.entries(oldProperties).filter(([key]) => key !== "url")),
        Object.fromEntries(Object.entries(newProperties).filter(([key]) => key !== "url")),
      ) && !isDeepStrictEqual(oldProperties.url, newProperties.url),
    newUrlIsComputed: newProperties.url === "04da6b54-80e4-46f7-96ec-b56ff0331ba9",
    includeUnchanged: isDeepStrictEqual(oldInputs.include, newInputs.include),
  }
}

function valueKind(value: unknown) {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function version(key: string, value: unknown) {
  return ["cloudflare:version", "random:version"].includes(key) &&
    typeof value === "string" &&
    /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
    ? value
    : null
}

function opaqueKinds(value: unknown): string[] {
  if (typeof value === "string") {
    return [
      ...(value.includes("[secret]") ? ["secret-mask"] : []),
      ...(value.includes("[unknown]") || value === "04da6b54-80e4-46f7-96ec-b56ff0331ba9" ? ["computed"] : []),
    ]
  }
  if (Array.isArray(value)) return [...new Set(value.flatMap(opaqueKinds))]
  const item = record(value)
  if (!item) return []
  // Public Pulumi serialization markers. Never include payloads or private paths.
  const marker = item[pulumiSignatureProperty]
  const markerKind =
    marker === pulumiHiddenValueSignature
      ? "secret-wrapper"
      : marker === pulumiAssetSignature
        ? "asset"
        : marker === pulumiArchiveSignature
          ? "archive"
          : marker === pulumiResourceSignature
            ? "resource-reference"
            : marker === pulumiOutputSignature
              ? "output-wrapper"
              : "serialization-marker"
  return [
    ...new Set([
      ...(marker !== undefined ? [markerKind] : []),
      ...(Object.hasOwn(item, "__pulumiUnknown") ? ["computed"] : []),
      ...(Object.keys(item).length === 1 && (Object.hasOwn(item, "secure") || Object.hasOwn(item, "ciphertext"))
        ? ["encrypted-value"]
        : []),
      ...Object.values(item).flatMap(opaqueKinds),
    ]),
  ]
}

function resourceKind(type: string, name: string, inTarget: boolean) {
  if (type === "pulumi:pulumi:Stack") return name === "mongolgpt-dev" ? "stack-metadata" : "other-stack-metadata"
  if (type === "pulumi:providers:cloudflare") return "cloudflare-provider"
  if (type === "pulumi:providers:random") return "random-provider"
  if (type === "pulumi:providers:pulumi-nodejs") return "dynamic-provider"
  if (type === "sst:sst:LinkRef") return "link-reference"
  if (type === "sst:sst:Version") return "component-version"
  if (!inTarget) return "other"
  if (type === "pulumi-nodejs:dynamic:Resource") {
    if (
      ["UsageQueueSubscriberFunctionUrl", "UsageQueueHeartbeatHandlerUrl"].some(
        (prefix) => name === `${prefix}.sst.cloudflare.WorkerUrl`,
      )
    )
      return "worker-url"
  }
  if (type === "cloudflare:index/workersScript:WorkersScript") return "worker-script"
  if (type === "cloudflare:index/queueConsumer:QueueConsumer") return "queue-consumer"
  if (type === "cloudflare:index/workersCronTrigger:WorkersCronTrigger") return "cron-trigger"
  if (["sst:cloudflare:Worker", "sst:cloudflare:Cron", "sst:cloudflare:QueueWorkerSubscriber"].includes(type))
    return "component"
  return "other"
}

function rejectionReasonFor(entries: unknown[]) {
  // Diagnostic only: the complete preview must still pass the separate guard.
  try {
    verifyUsageQueueDeploymentDiff(entries)
    return null
  } catch (error) {
    return error instanceof UsageQueueDeploymentGuardError ? error.reason : "unexpected-validation-error"
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
