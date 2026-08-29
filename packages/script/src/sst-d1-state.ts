const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class SstD1StateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SstD1StateError"
  }
}

export function extractSstD1DatabaseId(input: unknown, logicalName = "Database") {
  if (!record(input) || !record(input.deployment) || !Array.isArray(input.deployment.resources)) {
    throw new SstD1StateError("SST state-ийн deployment.resources жагсаалт дутуу байна.")
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(logicalName)) {
    throw new SstD1StateError("D1 logical name буруу байна.")
  }

  const ids = new Set<string>()
  for (const resource of input.deployment.resources) {
    if (!record(resource) || typeof resource.type !== "string" || typeof resource.urn !== "string") continue
    const name = resource.urn.split("::").at(-1) ?? ""
    const outputs = record(resource.outputs) ? resource.outputs : {}

    if (resource.type === "sst:cloudflare:D1" && name === logicalName) {
      addUuid(ids, outputs.databaseId, `SST ${logicalName} component`)
      continue
    }

    if (/cloudflare:index\/d1Database:D1Database$/i.test(resource.type) && name.startsWith(logicalName)) {
      if (outputs.uuid !== undefined) addUuid(ids, outputs.uuid, `Cloudflare ${logicalName} resource`)
      else if (typeof resource.id === "string") {
        addUuid(ids, resource.id.split("/").at(-1), `Cloudflare ${logicalName} resource id`)
      }
    }
  }

  if (ids.size !== 1) {
    throw new SstD1StateError(`SST state дотроос ${logicalName} D1 UUID яг нэг олдох ёстой, ${ids.size} олдлоо.`)
  }
  return [...ids][0]
}

function addUuid(ids: Set<string>, value: unknown, source: string) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SstD1StateError(`${source}-ийн UUID буруу байна.`)
  }
  ids.add(value.toLowerCase())
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
