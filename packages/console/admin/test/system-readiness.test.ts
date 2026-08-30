import { describe, expect, test } from "bun:test"
import {
  collectD1BackupEvidence,
  collectSystemReadiness,
  type D1BackupBucket,
  type SystemReadinessDependencies,
} from "../src/lib/system-readiness"
import {
  collectPublishedReleaseEvidence,
  RELEASE_READINESS_ARTIFACTS,
  RELEASE_READINESS_CHECKSUM,
  RELEASE_READINESS_PACKAGES,
  releaseTag,
  releaseUpdaterMetadataAssets,
  type PublishedReleaseEvidence,
  validatePublishedReleaseEvidence,
} from "../src/lib/release-readiness"
import {
  CLI_RELEASE_ASSETS,
  DESKTOP_RELEASE_ASSETS,
  RELEASE_CHECKSUM_ASSET,
  releaseUpdaterMetadataAssets as canonicalUpdaterMetadataAssets,
} from "../../../script/src/release-integrity"

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

const now = new Date("2026-08-19T00:00:00.000Z")
const databaseID = "01234567-89ab-cdef-0123-456789abcdef"
const releaseVersion = "0.1.1"

const queueHeartbeat = () =>
  JSON.stringify({
    version: 2,
    stage: "dev",
    id: "heartbeat-secret-id",
    sentAt: now.getTime() - 60_000,
    processedAt: now.getTime() - 30_000,
  })

const monitorEvidence = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    stage: "dev",
    checkedAt: now.getTime() - 60_000,
    status: "ok",
    checks: ["console", "auth", "runtime", "payments"].map((service) => ({
      service,
      ok: true,
      httpStatus: 200,
      latencyMs: 25,
    })),
    ...overrides,
  })

const backup = (overrides: Record<string, unknown> = {}) => ({
  key: "d1/dev/2026/08/18/2026-08-18T23-55-00.000Z-database.sql",
  size: 1_024,
  etag: "sql-etag-1",
  uploaded: new Date("2026-08-18T23:56:00.000Z"),
  httpMetadata: { contentType: "application/sql" },
  customMetadata: {
    createdAt: "2026-08-18T23:55:00.000Z",
    source: "cloudflare-d1-export",
    stage: "dev",
    databaseId: databaseID,
    manifestVersion: "1",
  },
  ...overrides,
})

const backupEvidence = (
  artifactOverrides: Record<string, unknown> = {},
  manifestOverrides: Record<string, unknown> = {},
) => {
  const artifact = backup(artifactOverrides)
  const manifest = {
    version: 1,
    kind: "mongolgpt-d1-backup",
    source: "cloudflare-d1-export",
    stage: "dev",
    databaseId: databaseID,
    bookmark: "00000001-00000002-00000003-00000004",
    createdAt: "2026-08-18T23:55:00.000Z",
    artifact: {
      key: artifact.key,
      size: artifact.size,
      etag: artifact.etag,
      contentType: "application/sql",
    },
    ...manifestOverrides,
  }
  const manifestBody = JSON.stringify(manifest)
  const manifestKey = `${artifact.key}.manifest.json`
  return {
    manifestKey,
    manifestBody,
    manifestObject: {
      key: manifestKey,
      size: new TextEncoder().encode(manifestBody).byteLength,
      etag: "manifest-etag-1",
      uploaded: new Date("2026-08-18T23:57:00.000Z"),
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        createdAt: manifest.createdAt,
        source: "mongolgpt-d1-backup-manifest",
        stage: manifest.stage,
        databaseId: manifest.databaseId,
        version: String(manifest.version),
      },
    },
    artifactObject: artifact,
  }
}

const updaterFiles = {
  windows: ["mongolgpt-desktop-win-arm64.exe", "mongolgpt-desktop-win-x64.exe"],
  linuxX64: [
    "mongolgpt-desktop-linux-x64.AppImage",
    "mongolgpt-desktop-linux-x64.deb",
    "mongolgpt-desktop-linux-x64.rpm",
  ],
  linuxArm64: [
    "mongolgpt-desktop-linux-arm64.AppImage",
    "mongolgpt-desktop-linux-arm64.deb",
    "mongolgpt-desktop-linux-arm64.rpm",
  ],
  mac: ["mongolgpt-desktop-mac-arm64.zip", "mongolgpt-desktop-mac-x64.zip"],
} as const

function updaterYml(files: readonly string[]) {
  return [
    `version: ${releaseVersion}`,
    "files:",
    ...files.flatMap((name) => [
      `  - url: ${name}`,
      `    sha512: ${"A".repeat(64)}`,
      "    size: 1024",
      "    blockMapSize: 64",
    ]),
  ].join("\n")
}

function releaseEvidence(): PublishedReleaseEvidence {
  const channel = "latest" as const
  const tag = releaseTag(releaseVersion)
  const body = [
    "## Өөрчлөлтийн жагсаалт",
    "- MongolGPT бэлэн боллоо.",
    "## Суулгах",
    `npm install -g mongolgpt@${releaseVersion}`,
    "## Шинэчлэх",
    `mongolgpt upgrade ${releaseVersion}`,
    "## Файлын бүрэн бүтэн байдал",
    RELEASE_READINESS_CHECKSUM,
  ].join("\n\n")
  const metadataAssets = releaseUpdaterMetadataAssets(channel)
  const assets = [...RELEASE_READINESS_ARTIFACTS, RELEASE_READINESS_CHECKSUM, ...Object.values(metadataAssets)].map(
    (name) => ({ name, size: 1024, state: "uploaded" }),
  )
  const packages = Object.fromEntries(
    RELEASE_READINESS_PACKAGES.map((name) => [
      name,
      {
        name,
        version: releaseVersion,
        bin: name === "mongolgpt" ? { mongolgpt: "bin/mongolgpt" } : undefined,
        dist: {
          tarball: `https://registry.npmjs.org/${name.replace("/", "-")}-${releaseVersion}.tgz`,
          integrity: `sha512-${"A".repeat(64)}`,
        },
      },
    ]),
  ) as PublishedReleaseEvidence["packages"]
  return {
    version: releaseVersion,
    channel,
    release: { tag_name: tag, draft: false, prerelease: false, body, assets },
    checksumText: RELEASE_READINESS_ARTIFACTS.map((name) => `${"a".repeat(64)}  ${name}`).join("\n"),
    metadata: {
      windows: updaterYml(updaterFiles.windows),
      linuxX64: updaterYml(updaterFiles.linuxX64),
      linuxArm64: updaterYml(updaterFiles.linuxArm64),
      mac: updaterYml(updaterFiles.mac),
    },
    packages,
  }
}

function dependencies(overrides: Partial<SystemReadinessDependencies> = {}): SystemReadinessDependencies {
  return {
    stage: "dev",
    databaseID,
    runtimeURL: "https://runtime.dev.mgpt.mn",
    releaseVersion,
    backupsEnabled: true,
    monitoringEnabled: true,
    database: async () => undefined,
    auth: async () => json({ status: "ok", service: "auth" }),
    quota: async () => json({ status: "ok", service: "quota", storage: "durable-objects", queue: "cloudflare-queues" }),
    payments: async () =>
      json({
        status: "ok",
        service: "payments",
        environment: "sandbox",
        providers: { qpay: true, bonum: true },
        catalog: true,
        checkout: true,
        cancellation: true,
        refund: true,
      }),
    runtime: async () => json({ healthy: true, version: "0.1.1" }),
    queueHeartbeat: async () => queueHeartbeat(),
    monitorEvidence: async () => monitorEvidence(),
    backups: async () => [backupEvidence()],
    release: async () => releaseEvidence(),
    now: () => now,
    ...overrides,
  }
}

describe("MongolGPT admin system readiness", () => {
  test("reports verified services without exposing provider secrets", async () => {
    const report = await collectSystemReadiness(dependencies())

    expect(report.status).toBe("ok")
    expect(report.stage).toBe("dev")
    expect(report.checkedAt).toBe("2026-08-19T00:00:00.000Z")
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.state]))).toEqual({
      database: "healthy",
      runtime: "healthy",
      oauth: "healthy",
      quota: "healthy",
      "usage-queue": "healthy",
      payments: "healthy",
      monitoring: "healthy",
      backup: "healthy",
      release: "healthy",
    })
    expect(JSON.stringify(report)).not.toContain("heartbeat-secret-id")
    expect(JSON.stringify(report)).not.toContain("database.sql")
  })

  test("fails individual checks closed while keeping the report available", async () => {
    const report = await collectSystemReadiness(
      dependencies({
        runtimeURL: "",
        database: async () => {
          throw new Error("secret database diagnostic")
        },
        auth: async () => new Response("<html>not json</html>", { status: 200 }),
        quota: async () => json({ status: "ok", service: "quota" }),
        payments: async () =>
          json({
            status: "disabled",
            service: "payments",
            environment: "disabled",
            providers: { qpay: false, bonum: false },
            catalog: false,
            checkout: false,
            cancellation: false,
            refund: false,
          }),
        backups: async () => [],
        queueHeartbeat: async () => null,
      }),
    )

    expect(report.status).toBe("degraded")
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.state]))).toEqual({
      database: "degraded",
      runtime: "missing",
      oauth: "degraded",
      quota: "degraded",
      "usage-queue": "degraded",
      payments: "disabled",
      monitoring: "healthy",
      backup: "degraded",
      release: "healthy",
    })
    expect(JSON.stringify(report)).not.toContain("secret database diagnostic")
  })

  test("rejects HTTP success responses with the wrong health schema", async () => {
    const report = await collectSystemReadiness(
      dependencies({
        runtime: async () => json({ healthy: true }),
        auth: async () => json({ status: "ok", service: "auth", token: "must-not-pass" }),
      }),
    )

    expect(report.checks.find((check) => check.id === "runtime")?.state).toBe("degraded")
    expect(report.checks.find((check) => check.id === "oauth")?.state).toBe("degraded")
    expect(JSON.stringify(report)).not.toContain("must-not-pass")
  })

  test("fails stale, malformed, legacy, or wrong-stage queue heartbeat evidence closed", async () => {
    const evidence = [
      "not-json",
      JSON.stringify({
        version: 2,
        stage: "dev",
        id: "stale",
        sentAt: now.getTime() - 1_000_000,
        processedAt: now.getTime() - 950_000,
      }),
      JSON.stringify({
        version: 2,
        stage: "dev",
        id: "reversed",
        sentAt: now.getTime(),
        processedAt: now.getTime() - 1,
      }),
      JSON.stringify({
        version: 2,
        stage: "dev",
        id: "future",
        sentAt: now.getTime() + 180_000,
        processedAt: now.getTime() + 180_000,
      }),
      queueHeartbeat().replace('"stage":"dev"', '"stage":"production"'),
      queueHeartbeat().replace('"version":2', '"version":1'),
    ]

    for (const value of evidence) {
      const report = await collectSystemReadiness(dependencies({ queueHeartbeat: async () => value }))
      expect(report.checks.find((check) => check.id === "usage-queue")?.state).toBe("degraded")
    }
  })

  test("requires recent, bounded D1 export evidence for the active stage", async () => {
    const objects = [
      backup({
        key: "d1/dev/2026/08/17/2026-08-17T00-00-00.000Z-database.sql",
        uploaded: new Date("2026-08-17T00:01:00.000Z"),
        customMetadata: {
          createdAt: "2026-08-17T00:00:00.000Z",
          source: "cloudflare-d1-export",
          stage: "dev",
        },
      }),
      backup({ key: "d1/production/2026/08/18/2026-08-18T23-55-00.000Z-database.sql" }),
      backup({ size: 10 * 1024 * 1024 * 1024 + 1 }),
      backup({ customMetadata: { createdAt: "2026-08-18T23:55:00.000Z", source: "unknown", stage: "dev" } }),
    ]

    for (const object of objects) {
      const report = await collectSystemReadiness(dependencies({ backups: async () => [backupEvidence(object)] }))
      expect(report.checks.find((check) => check.id === "backup")?.state).toBe("degraded")
    }
  })

  test("requires an exact manifest, R2 object, and active database binding", async () => {
    const candidates = [
      backupEvidence({}, { stage: "production" }),
      backupEvidence({}, { databaseId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
      {
        ...backupEvidence(),
        artifactObject: { ...(backupEvidence().artifactObject as Record<string, unknown>), etag: "different-etag" },
      },
      backupEvidence({ httpMetadata: { contentType: "text/plain" } }),
      { ...backupEvidence(), manifestBody: "not-json" },
      { ...backupEvidence(), artifactObject: null },
    ]

    for (const candidate of candidates) {
      const report = await collectSystemReadiness(dependencies({ backups: async () => [candidate] }))
      expect(report.checks.find((check) => check.id === "backup")?.state).toBe("degraded")
      expect(JSON.stringify(report)).not.toContain(databaseID)
      expect(JSON.stringify(report)).not.toContain("00000001-00000002")
    }
  })

  test("paginates manifest discovery and re-reads the committed SQL object with head", async () => {
    const committed = backupEvidence()
    const listCalls: Array<{ cursor?: string; include?: string[] }> = []
    const headCalls: string[] = []
    const bucket: D1BackupBucket = {
      async list(options) {
        listCalls.push({ cursor: options?.cursor, include: options?.include })
        if (!options?.cursor) return { objects: [], truncated: true, cursor: "page-2" }
        return { objects: [committed.manifestObject], truncated: false }
      },
      async get(key) {
        if (key !== committed.manifestKey) return null
        return {
          ...(committed.manifestObject as {
            key: string
            etag: string
            size: number
            uploaded: Date
            httpMetadata: Record<string, unknown>
            customMetadata: Record<string, string>
          }),
          text: async () => committed.manifestBody,
        }
      },
      async head(key) {
        headCalls.push(key)
        return committed.artifactObject
      },
    }

    const evidence = await collectD1BackupEvidence(bucket, "dev", databaseID)
    expect(evidence).toHaveLength(1)
    expect(listCalls).toEqual([
      { cursor: undefined, include: ["httpMetadata", "customMetadata"] },
      { cursor: "page-2", include: ["httpMetadata", "customMetadata"] },
    ])
    expect(headCalls).toEqual([(committed.artifactObject as { key: string }).key])
  })

  test("fails closed on repeated pagination cursors and missing manifest bodies", async () => {
    const committed = backupEvidence()
    const repeatedCursor: D1BackupBucket = {
      list: async () => ({ objects: [], truncated: true, cursor: "same" }),
      get: async () => null,
      head: async () => null,
    }
    const paginationError = await collectD1BackupEvidence(repeatedCursor, "dev", databaseID).catch((error) => error)
    if (!(paginationError instanceof Error)) throw new Error("Expected pagination error")
    expect(paginationError.message).toContain("cursor")

    const missingBody: D1BackupBucket = {
      list: async () => ({ objects: [committed.manifestObject], truncated: false }),
      get: async () => null,
      head: async () => committed.artifactObject,
    }
    expect(await collectD1BackupEvidence(missingBody, "dev", databaseID)).toEqual([])
  })

  test("fails stale, malformed, wrong-stage, or degraded monitoring evidence closed", async () => {
    const evidence = [
      "not-json",
      monitorEvidence({ checkedAt: now.getTime() - 1_000_000 }),
      monitorEvidence({ stage: "production" }),
      monitorEvidence({
        status: "degraded",
        checks: [
          { service: "console", ok: false, httpStatus: 503, latencyMs: 25, failure: "http" },
          ...["auth", "runtime", "payments"].map((service) => ({
            service,
            ok: true,
            httpStatus: 200,
            latencyMs: 25,
          })),
        ],
      }),
    ]

    for (const value of evidence) {
      const report = await collectSystemReadiness(dependencies({ monitorEvidence: async () => value }))
      expect(report.checks.find((check) => check.id === "monitoring")?.state).toBe("degraded")
    }
  })

  test("reports disabled monitoring without reading its KV state", async () => {
    let probed = false
    const report = await collectSystemReadiness(
      dependencies({
        monitoringEnabled: false,
        monitorEvidence: async () => {
          probed = true
          throw new Error("must not run")
        },
      }),
    )

    expect(probed).toBe(false)
    expect(report.status).toBe("degraded")
    expect(report.checks.find((check) => check.id === "monitoring")?.state).toBe("disabled")
  })

  test("reports disabled backup automation without probing R2", async () => {
    let probed = false
    const report = await collectSystemReadiness(
      dependencies({
        backupsEnabled: false,
        backups: async () => {
          probed = true
          throw new Error("must not run")
        },
      }),
    )

    expect(probed).toBe(false)
    expect(report.status).toBe("degraded")
    expect(report.checks.find((check) => check.id === "backup")?.state).toBe("disabled")
  })

  test("keeps the live release gate aligned with the canonical publish contract", () => {
    expect([...RELEASE_READINESS_ARTIFACTS]).toEqual([...CLI_RELEASE_ASSETS, ...DESKTOP_RELEASE_ASSETS])
    expect(RELEASE_READINESS_CHECKSUM).toBe(RELEASE_CHECKSUM_ASSET)
    expect(releaseUpdaterMetadataAssets("latest")).toEqual(canonicalUpdaterMetadataAssets("latest"))
    expect(releaseUpdaterMetadataAssets("beta")).toEqual(canonicalUpdaterMetadataAssets("beta"))
  })

  test("fails incomplete public release channels closed", async () => {
    const missingPackage = releaseEvidence()
    missingPackage.packages = { ...missingPackage.packages, "@mongolgpt/sdk": null }
    const draftRelease = releaseEvidence()
    draftRelease.release = draftRelease.release ? { ...draftRelease.release, draft: true } : null
    const missingAsset = releaseEvidence()
    missingAsset.release = missingAsset.release
      ? {
          ...missingAsset.release,
          assets: missingAsset.release.assets.filter((asset) => asset.name !== "mongolgpt-desktop-linux-arm64.deb"),
        }
      : null
    const brokenUpdater = releaseEvidence()
    brokenUpdater.metadata = { ...brokenUpdater.metadata, windows: "version: 9.9.9\nfiles: []\n" }
    const missingChecksum = releaseEvidence()
    missingChecksum.checksumText = undefined

    for (const evidence of [missingPackage, draftRelease, missingAsset, brokenUpdater, missingChecksum]) {
      expect(validatePublishedReleaseEvidence(evidence).length).toBeGreaterThan(0)
      const report = await collectSystemReadiness(dependencies({ release: async () => evidence }))
      const check = report.checks.find((item) => item.id === "release")
      expect(check?.state).toBe("degraded")
      expect(check?.summary).not.toContain("@mongolgpt/sdk")
    }
  })

  test("reports a missing release version without making public network requests", async () => {
    let probed = false
    const report = await collectSystemReadiness(
      dependencies({
        releaseVersion: "",
        release: async () => {
          probed = true
          throw new Error("must not run")
        },
      }),
    )

    expect(probed).toBe(false)
    expect(report.status).toBe("degraded")
    expect(report.checks.find((check) => check.id === "release")?.state).toBe("missing")
  })

  test("collects only fixed GitHub and npm release endpoints with bounded public metadata", async () => {
    const expected = releaseEvidence()
    const metadataNames = releaseUpdaterMetadataAssets("latest")
    const requested: string[] = []
    const requestOptions: RequestInit[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requested.push(url)
      requestOptions.push(init ?? {})
      if (url.startsWith("https://api.github.com/")) return json(expected.release)
      for (const name of RELEASE_READINESS_PACKAGES) {
        if (url === `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`) {
          return json(expected.packages[name])
        }
      }
      if (url.endsWith(`/${RELEASE_READINESS_CHECKSUM}`)) return new Response(expected.checksumText)
      for (const [kind, name] of Object.entries(metadataNames)) {
        if (url.endsWith(`/${name}`)) {
          return new Response(expected.metadata[kind as keyof typeof expected.metadata])
        }
      }
      return new Response("missing", { status: 404 })
    }

    const collected = await collectPublishedReleaseEvidence({ version: releaseVersion, fetcher })
    expect(validatePublishedReleaseEvidence(collected)).toEqual([])
    expect(requested).toHaveLength(10)
    expect(requested.every((url) => new URL(url).protocol === "https:")).toBe(true)
    expect(
      requested.every((url) => ["api.github.com", "github.com", "registry.npmjs.org"].includes(new URL(url).hostname)),
    ).toBe(true)
    expect(requested.some((url) => url.includes(releaseTag(releaseVersion)))).toBe(true)
    expect(requestOptions.every((options) => options.redirect === "follow")).toBe(true)
    expect(
      requestOptions.every((options) => {
        const value = Reflect.get(options, "cf") as Record<string, unknown> | undefined
        return value?.cacheEverything === true && value.cacheTtl === 300
      }),
    ).toBe(true)
  })
})
