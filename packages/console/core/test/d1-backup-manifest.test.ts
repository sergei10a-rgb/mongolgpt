import { describe, expect, test } from "bun:test"
import {
  createD1BackupManifest,
  D1_BACKUP_MANIFEST_MAX_BYTES,
  d1BackupManifestKey,
  parseD1BackupManifest,
} from "../src/d1-backup-manifest"

const manifest = () => ({
  version: 1 as const,
  kind: "mongolgpt-d1-backup" as const,
  source: "cloudflare-d1-export" as const,
  stage: "dev",
  databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  bookmark: "bookmark-1",
  createdAt: "2026-08-27T00:20:00.000Z",
  artifact: {
    key: "d1/dev/2026/08/27/2026-08-27T00-20-00.000Z-database.sql",
    size: 1024,
    etag: "etag-1",
    contentType: "application/sql" as const,
  },
})

describe("D1 backup manifest", () => {
  test("validates and derives the sibling manifest key", () => {
    const value = createD1BackupManifest(manifest())
    expect(value.artifact.size).toBe(1024)
    expect(d1BackupManifestKey(value.artifact.key)).toBe(`${value.artifact.key}.manifest.json`)
    expect(parseD1BackupManifest(JSON.stringify(value), { stage: "dev", databaseId: value.databaseId })).toEqual(value)
  })

  test("rejects wrong stage, database, key, size, and unbounded content", () => {
    expect(() => parseD1BackupManifest(JSON.stringify(manifest()), { stage: "production" })).toThrow("орчин")
    expect(() =>
      parseD1BackupManifest(JSON.stringify(manifest()), {
        databaseId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).toThrow("өгөгдлийн сантай")
    expect(() =>
      createD1BackupManifest({
        ...manifest(),
        artifact: { ...manifest().artifact, key: "d1/dev/2026/08/26/2026-08-26T00-20-00.000Z.sql" },
      }),
    ).toThrow("хугацаатай таарахгүй")
    expect(() =>
      createD1BackupManifest({
        ...manifest(),
        createdAt: "2026-08-27T00:20:00Z",
        artifact: { ...manifest().artifact, key: "d1/dev/2026/08/27/2026-08-27T00-20-00Z-database.sql" },
      }),
    ).toThrow("хугацаа буруу")
    expect(() => createD1BackupManifest({ ...manifest(), artifact: { ...manifest().artifact, size: 0 } })).toThrow(
      "бүтэц буруу",
    )
    expect(() => parseD1BackupManifest("x".repeat(D1_BACKUP_MANIFEST_MAX_BYTES + 1))).toThrow("хэт том")
  })

  test("keeps the schema strict and rejects unsafe strings", () => {
    expect(() => createD1BackupManifest({ ...manifest(), token: "must-not-exist" })).toThrow("бүтэц буруу")
    expect(() => createD1BackupManifest({ ...manifest(), bookmark: "bookmark\nsecret" })).toThrow("бүтэц буруу")
    expect(() => d1BackupManifestKey("../database.sql")).toThrow("түлхүүр буруу")
    expect(() => d1BackupManifestKey("d1/dev/2026/08/27/2026-08-27T00-20-00.000Z/nested-database.sql")).toThrow(
      "түлхүүр буруу",
    )
  })
})
