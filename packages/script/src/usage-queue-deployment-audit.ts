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
])

// Report only bounded deployment metadata, never state inputs, outputs, or code.
export function summarizeUsageQueueDeploymentDiff(value: unknown) {
  if (!Array.isArray(value) || value.length > 2_000) throw new Error("Invalid queue deployment diff")
  const changes = value.map((raw) => {
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
    return {
      target,
      operation: entry.op,
      resource: target === "outside-targets" ? "other" : resourceKind(entry.type),
      fields: [
        ...new Set(
          Object.keys(detail ?? {}).map((path) => {
            const root = path.split(/[.\[]/, 1)[0]
            return fields.has(root) ? root : "other"
          }),
        ),
      ].sort(),
      detailedDiffAvailable: detail !== undefined,
    }
  })
  return { stage: "dev", targets, count: changes.length, changes }
}

function resourceKind(type: string) {
  if (type === "cloudflare:index/workersScript:WorkersScript") return "worker-script"
  if (type === "cloudflare:index/queueConsumer:QueueConsumer") return "queue-consumer"
  if (type === "cloudflare:index/workersCronTrigger:WorkersCronTrigger") return "cron-trigger"
  if (type === "sst:sst:LinkRef") return "link-reference"
  if (["sst:cloudflare:Worker", "sst:cloudflare:Cron", "sst:cloudflare:QueueWorkerSubscriber"].includes(type))
    return "component"
  return "other"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
