import { z } from "zod"

export const D1_BACKUP_MAX_BYTES = 10 * 1024 * 1024 * 1024
export const D1_BACKUP_MANIFEST_MAX_BYTES = 16 * 1024
export const D1_BACKUP_MANIFEST_SUFFIX = ".manifest.json"

const databaseID = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)
const stage = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const artifactKey = z
  .string()
  .trim()
  .min(1)
  .max(1024 - D1_BACKUP_MANIFEST_SUFFIX.length)
  .regex(/^d1\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/\d{4}\/\d{2}\/\d{2}\/[^/\\\r\n]+\.sql$/)
const boundedText = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[^\r\n\t]+$/)

export const D1BackupManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("mongolgpt-d1-backup"),
    source: z.literal("cloudflare-d1-export"),
    stage,
    databaseId: databaseID,
    bookmark: boundedText,
    createdAt: z.string().datetime(),
    artifact: z
      .object({
        key: artifactKey,
        size: z.number().int().positive().max(D1_BACKUP_MAX_BYTES),
        etag: boundedText,
        contentType: z.literal("application/sql"),
      })
      .strict(),
  })
  .strict()

export type D1BackupManifest = z.output<typeof D1BackupManifestSchema>

export function createD1BackupManifest(input: unknown) {
  return validateD1BackupManifest(input)
}

export function parseD1BackupManifest(
  body: string,
  expected?: { stage?: string; databaseId?: string },
): D1BackupManifest {
  if (new TextEncoder().encode(body).byteLength > D1_BACKUP_MANIFEST_MAX_BYTES) {
    throw new D1BackupManifestError("manifest_too_large", "D1 нөөц хуулбарын manifest хэт том байна.")
  }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new D1BackupManifestError("manifest_invalid_json", "D1 нөөц хуулбарын manifest зөв JSON биш байна.")
  }
  return validateD1BackupManifest(value, expected)
}

export function validateD1BackupManifest(
  value: unknown,
  expected?: { stage?: string; databaseId?: string },
): D1BackupManifest {
  const parsed = D1BackupManifestSchema.safeParse(value)
  if (!parsed.success) {
    throw new D1BackupManifestError("manifest_invalid", "D1 нөөц хуулбарын manifest бүтэц буруу байна.")
  }
  const manifest = parsed.data
  const createdAt = new Date(manifest.createdAt)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== manifest.createdAt) {
    throw new D1BackupManifestError("created_at_invalid", "D1 нөөц хуулбарын manifest хугацаа буруу байна.")
  }
  const [day] = manifest.createdAt.split("T")
  const timestamp = manifest.createdAt.replaceAll(":", "-")
  const expectedPrefix = `d1/${manifest.stage}/${day.replaceAll("-", "/")}/${timestamp}-`
  if (!manifest.artifact.key.startsWith(expectedPrefix)) {
    throw new D1BackupManifestError(
      "artifact_key_mismatch",
      "D1 нөөц хуулбарын manifest дахь объектын түлхүүр орчин, хугацаатай таарахгүй байна.",
    )
  }
  if (expected?.stage && manifest.stage !== expected.stage.trim().toLowerCase()) {
    throw new D1BackupManifestError("stage_mismatch", "D1 нөөц хуулбарын manifest орчин таарахгүй байна.")
  }
  if (expected?.databaseId && manifest.databaseId.toLowerCase() !== expected.databaseId.trim().toLowerCase()) {
    throw new D1BackupManifestError("database_mismatch", "D1 нөөц хуулбарын manifest өгөгдлийн сантай таарахгүй байна.")
  }
  return manifest
}

export function d1BackupManifestKey(artifact: string) {
  const key = artifactKey.safeParse(artifact)
  if (!key.success) throw new D1BackupManifestError("artifact_key_invalid", "D1 нөөц хуулбарын түлхүүр буруу байна.")
  return `${key.data}${D1_BACKUP_MANIFEST_SUFFIX}`
}

export class D1BackupManifestError extends Error {
  constructor(
    readonly code:
      | "manifest_too_large"
      | "manifest_invalid_json"
      | "manifest_invalid"
      | "artifact_key_invalid"
      | "artifact_key_mismatch"
      | "created_at_invalid"
      | "stage_mismatch"
      | "database_mismatch",
    message: string,
  ) {
    super(message)
    this.name = "D1BackupManifestError"
  }
}
