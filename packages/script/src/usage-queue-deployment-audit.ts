import { isDeepStrictEqual } from "node:util"
import { UsageQueueDeploymentGuardError, verifyUsageQueueDeploymentDiff } from "./usage-queue-deployment-guard"

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
])

// Pulumi 3.215.0 providers/registry.go reserves these engine metadata fields.
const internalFields = new Set(["name", "version", "pluginDownloadURL", "pluginChecksums", "parameterization"])

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
    const rejectionReason = rejectionReasonFor(entry)
    return {
      target,
      operation: entry.op,
      resource: resourceKind(entry.type, urn[3], target !== "outside-targets"),
      sameResourceAs,
      identicalPreviousEvent: sameResourceAs === null ? null : isDeepStrictEqual(value[sameResourceAs], entry),
      allowedIndividually: rejectionReason === null,
      rejectionReason,
      metadataEvidence: metadataEvidence(entry.type, oldInputs, newInputs),
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
  return { stage: "dev", targets, count: changes.length, changes }
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

function rejectionReasonFor(entry: unknown) {
  // Diagnostic only: the complete preview must still pass the separate guard.
  try {
    verifyUsageQueueDeploymentDiff([entry])
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
