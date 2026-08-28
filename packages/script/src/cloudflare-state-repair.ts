const TARGET_QUEUE_URN =
  "urn:pulumi:dev::mongolgpt::sst:cloudflare:Queue$cloudflare:index/queue:Queue::UsageQueueQueue"
const DANGLING_PROVIDER_REFERENCE =
  "urn:pulumi:dev::mongolgpt::pulumi:providers:cloudflare::default_6_13_0::9a45bc90-e476-4ef5-9e66-8febc7016477"
const REPLACEMENT_PROVIDER_NAME = "default_6_14_0"

type JsonRecord = Record<string, unknown>
type StateResource = JsonRecord & {
  urn?: string
  type?: string
  id?: string
  provider?: string
}

export type CloudflareStateRepairResult = {
  changed: boolean
  resourceUrn: string
  previousProvider: string
  provider: string
}

export function repairCloudflareQueueProviderState(root: unknown): CloudflareStateRepairResult {
  const resources = findTargetResourceArray(root)
  const target = resources.find((resource) => resource.urn === TARGET_QUEUE_URN)
  if (!target || target.type !== "cloudflare:index/queue:Queue") {
    throw new Error("UsageQueueQueue Cloudflare queue state-ээс олдсонгүй.")
  }

  const candidates = resources.filter(
    (resource) =>
      resource.type === "pulumi:providers:cloudflare" &&
      resource.urn?.endsWith(`::${REPLACEMENT_PROVIDER_NAME}`) &&
      typeof resource.id === "string" &&
      resource.id.length > 0,
  )
  if (candidates.length !== 1) {
    throw new Error(`Cloudflare 6.14 provider state яг нэг байх ёстой, ${candidates.length} байна.`)
  }

  const replacement = `${candidates[0].urn}::${candidates[0].id}`
  if (target.provider === replacement) {
    return {
      changed: false,
      resourceUrn: TARGET_QUEUE_URN,
      previousProvider: replacement,
      provider: replacement,
    }
  }

  const dangling = resources.filter((resource) => resource.provider === DANGLING_PROVIDER_REFERENCE)
  if (dangling.length !== 1 || dangling[0] !== target) {
    const names = dangling.map((resource) => resource.urn ?? "unknown").join(", ") || "none"
    throw new Error(`Хуучин Cloudflare provider-г заасан resource-ийн жагсаалт хүлээлтээс зөрлөө: ${names}`)
  }
  if (target.provider !== DANGLING_PROVIDER_REFERENCE) {
    throw new Error(`UsageQueueQueue provider reference хүлээлтээс зөрлөө: ${target.provider ?? "missing"}`)
  }

  target.provider = replacement
  return {
    changed: true,
    resourceUrn: TARGET_QUEUE_URN,
    previousProvider: DANGLING_PROVIDER_REFERENCE,
    provider: replacement,
  }
}

function findTargetResourceArray(root: unknown): StateResource[] {
  const matches: StateResource[][] = []

  function visit(value: unknown) {
    if (!record(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "resources" && Array.isArray(child)) {
        const resources = child.filter(record) as StateResource[]
        if (resources.some((resource) => resource.urn === TARGET_QUEUE_URN)) matches.push(resources)
        continue
      }
      if (record(child)) visit(child)
    }
  }

  visit(root)
  if (matches.length !== 1) {
    throw new Error(`UsageQueueQueue агуулсан resources массив яг нэг байх ёстой, ${matches.length} байна.`)
  }
  return matches[0]
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
