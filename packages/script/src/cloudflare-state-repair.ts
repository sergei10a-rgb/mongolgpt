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
  rewired: number
  removedDuplicates: number
}

export type CloudflareStateAudit = {
  targetProviders: { path: string; provider: string }[]
  exactDanglingPaths: string[]
  danglingMentionPaths: string[]
}

export function auditCloudflareQueueProviderState(root: unknown): CloudflareStateAudit {
  const targetProviders: CloudflareStateAudit["targetProviders"] = []
  const exactDanglingPaths: string[] = []
  const danglingMentionPaths: string[] = []

  function visit(value: unknown, path: string) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`))
      return
    }
    if (!record(value)) return

    if (value.urn === TARGET_QUEUE_URN) {
      targetProviders.push({ path, provider: typeof value.provider === "string" ? value.provider : "missing" })
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      if (typeof child === "string" && child.includes(DANGLING_PROVIDER_REFERENCE)) {
        danglingMentionPaths.push(childPath)
        if (child === DANGLING_PROVIDER_REFERENCE) exactDanglingPaths.push(childPath)
      }
      if (typeof child === "object" && child !== null) visit(child, childPath)
    }
  }

  visit(root, "$")
  return { targetProviders, exactDanglingPaths, danglingMentionPaths }
}

export function repairCloudflareQueueProviderState(root: unknown): CloudflareStateRepairResult {
  const state = findTargetResourceArray(root)
  const resources = state.resources
  const targets = resources.filter((resource) => resource.urn === TARGET_QUEUE_URN)
  if (targets.length === 0 || targets.some((target) => target.type !== "cloudflare:index/queue:Queue")) {
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
  const dangling = resources.filter((resource) => resource.provider === DANGLING_PROVIDER_REFERENCE)
  if (dangling.length === 0) {
    if (targets.length !== 1 || targets[0].provider !== replacement) {
      throw new Error("UsageQueueQueue-ийн засагдсан state хүлээлтээс зөрлөө.")
    }
    return {
      changed: false,
      resourceUrn: TARGET_QUEUE_URN,
      previousProvider: replacement,
      provider: replacement,
      rewired: 0,
      removedDuplicates: 0,
    }
  }

  if (dangling.some((resource) => !resource.type?.startsWith("cloudflare:"))) {
    const names = dangling
      .filter((resource) => !resource.type?.startsWith("cloudflare:"))
      .map((resource) => resource.urn ?? "unknown")
      .join(", ")
    throw new Error(`Cloudflare бус resource устсан provider-г зааж байна: ${names}`)
  }

  const remove = new Set<StateResource>()
  let rewired = 0
  for (const resource of dangling) {
    if (!resource.urn) throw new Error("Устсан provider-г заасан resource URN-гүй байна.")
    const migratedCopies = resources.filter(
      (candidate) => candidate !== resource && candidate.urn === resource.urn && candidate.provider === replacement,
    )
    if (migratedCopies.length > 1) {
      throw new Error(`Migration-аар үүссэн resource copy нэгээс олон байна: ${resource.urn}`)
    }
    if (migratedCopies.length === 1) {
      remove.add(resource)
      continue
    }
    resource.provider = replacement
    rewired += 1
  }

  if (remove.size > 0) {
    state.owner.resources = resources.filter((resource) => !remove.has(resource))
  }
  clearIntegrityErrorMetadata(state.owner)

  const repairedResources = state.owner.resources as StateResource[]
  const repairedTargets = repairedResources.filter((resource) => resource.urn === TARGET_QUEUE_URN)
  if (repairedTargets.length !== 1 || repairedTargets[0].provider !== replacement) {
    throw new Error("UsageQueueQueue-ийн provider migration бүрэн дууссангүй.")
  }
  if (repairedResources.some((resource) => resource.provider === DANGLING_PROVIDER_REFERENCE)) {
    throw new Error("Устсан Cloudflare provider-г заасан resource үлдлээ.")
  }

  return {
    changed: true,
    resourceUrn: TARGET_QUEUE_URN,
    previousProvider: DANGLING_PROVIDER_REFERENCE,
    provider: replacement,
    rewired,
    removedDuplicates: remove.size,
  }
}

function findTargetResourceArray(root: unknown): { resources: StateResource[]; owner: JsonRecord } {
  const matches: { resources: StateResource[]; owner: JsonRecord }[] = []

  function visit(value: unknown) {
    if (!record(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "resources" && Array.isArray(child)) {
        const resources = child.filter(record) as StateResource[]
        if (resources.some((resource) => resource.urn === TARGET_QUEUE_URN)) matches.push({ resources, owner: value })
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

function clearIntegrityErrorMetadata(owner: JsonRecord) {
  if (!record(owner.metadata)) return
  delete owner.metadata.integrity_error
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
