import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

const root = await mkdtemp(join(tmpdir(), "mongolgpt-file-revision-"))
const scope = { accountID: "acc_files", workspaceID: "wrk_files" }
const configPath = fileURLToPath(new URL("./fixtures/history-d1.jsonc", import.meta.url))
const start = () =>
  getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>({
    configPath,
    persist: { path: join(root, "platform") },
    remoteBindings: false,
    envFiles: [],
  })
let platform: Awaited<ReturnType<typeof start>> | undefined
let assertions = 0
const equal = (actual: unknown, expected: unknown) => {
  assertions++
  assert.deepEqual(actual, expected)
}
const rejects = async (pending: Promise<unknown>, code: string) => {
  assertions++
  await assert.rejects(pending, (error: unknown) => error instanceof Error && Reflect.get(error, "code") === code)
}
try {
  for (const name of ["data", "config", "cache", "state"])
    process.env[`XDG_${name.toUpperCase()}_HOME`] = join(root, name)
  platform = await start()
  for (const name of ["0001_history.sql", "0002_history_checkpoint.sql", "0003_file_revision.sql"]) {
    const sql = await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8")
    for (const statement of unstable_splitSqlQuery(sql)) await platform.env.DB.prepare(statement).run()
  }
  const native: typeof import("./fixtures/history-native.ts") = await import(pathToFileURL(process.argv[2]).href)
  const env = () => ({
    HISTORY: platform!.env.DB as unknown as NonNullable<
      Parameters<typeof native.handleCheckpointOutbound>[1]["HISTORY"]
    >,
    RUNTIME_BACKUPS: platform!.env.BACKUPS as unknown as NonNullable<
      Parameters<typeof native.handleCheckpointOutbound>[1]["RUNTIME_BACKUPS"]
    >,
  })
  const fixture = await native.createCheckpointFixture(root, scope)
  const keys = { [fixture.input.sqlite.keyID]: fixture.master }
  const masterJSON = JSON.stringify({ [fixture.input.sqlite.keyID]: Buffer.from(fixture.master).toString("base64") })
  const stores = () => ({
    history: native.createHistoryStore(env().HISTORY),
    backups: native.createRuntimeBackupStore(env().RUNTIME_BACKUPS),
    checkpoints: native.createRuntimeCheckpointStore(env().HISTORY, env().RUNTIME_BACKUPS, keys),
  })
  const save = async (filename: string, plaintext: CloudCheckpoint.Archive["plaintext"]) => {
    const saved = await stores().backups.save(scope, {
      keyID: fixture.input.sqlite.keyID,
      body: new Response(await readFile(filename)).body!,
    })
    return { backupID: saved.backupID, keyID: saved.keyID, bytes: saved.bytes, sha256: saved.sha256, plaintext }
  }
  const checkpoint = {
    id: fixture.input.id,
    inventory: fixture.input.inventory,
    sqlite: await save(fixture.sqliteArchive, fixture.input.sqlite.plaintext),
    files: await save(fixture.filesArchive, fixture.input.files.plaintext),
  }
  const lease = await stores().history.claim(scope, { expectedEpoch: 0, writerID: "writer_files" })
  await stores().checkpoints.publish(lease, checkpoint)
  equal(await stores().history.fileRevision(scope), undefined)
  const key = native.deriveRuntimeBackupKey(scope, fixture.input.sqlite.keyID, fixture.master)
  const materialized = await native.restoreCheckpoint({
    parent: root,
    checkpoint,
    sqlite: { source: fixture.sqliteArchive, key },
    files: { source: fixture.filesArchive, key },
  })
  const capture = async (name: string) => {
    const destination = join(root, name)
    const result = await native.Effect.runPromise(
      native.WorkspaceCapture.create({
        source: materialized.directory,
        destination,
        key,
        exclude: [
          ".mongolgpt/runtime.sqlite",
          ".mongolgpt/runtime.sqlite-wal",
          ".mongolgpt/runtime.sqlite-shm",
          ".mongolgpt/runtime.sqlite-journal",
        ],
      }),
    )
    return save(destination, { bytes: result.report.bytes, sha256: result.report.sha256 })
  }
  await writeFile(join(materialized.directory, "synthetic/transcript.txt"), "revision one")
  const first: CloudCheckpoint.FileRevision = {
    id: crypto.randomUUID(),
    checkpointID: checkpoint.id,
    sequence: 1,
    previousID: null,
    archive: await capture("first.backup"),
  }
  const receipt = await stores().checkpoints.publishFiles(lease, first)
  equal(receipt.data, first)
  equal(await stores().checkpoints.publishFiles(lease, first), receipt)
  equal(await stores().checkpoints.readFiles(scope), receipt)
  await rejects(
    stores().checkpoints.publishFiles(lease, { ...first, archive: { ...first.archive, sha256: "0".repeat(64) } }),
    "invalid",
  )
  await rejects(
    stores().checkpoints.publishFiles(lease, {
      ...first,
      archive: { ...first.archive, plaintext: { ...first.archive.plaintext, sha256: "0".repeat(64) } },
    }),
    "invalid",
  )
  await rejects(stores().history.publishFiles(lease, { ...first, sequence: 0 }), "invalid_input")
  await rejects(stores().history.publishFiles(lease, { ...first, previousID: first.id }), "invalid_input")
  await rejects(
    stores().history.publishFiles(lease, { ...first, extra: true } as CloudCheckpoint.FileRevision),
    "invalid_input",
  )
  await rejects(
    stores().history.publishFiles(lease, { ...first, checkpointID: crypto.randomUUID(), id: crypto.randomUUID() }),
    "conflict",
  )
  equal(await stores().history.fileRevision(scope), receipt)

  await unlink(join(materialized.directory, "synthetic/transcript.txt"))
  await writeFile(join(materialized.directory, "synthetic/data.bin"), Buffer.from([255, 10, 0, 127]))
  await writeFile(join(materialized.directory, "synthetic/new.txt"), "new file after checkpoint")
  const second: CloudCheckpoint.FileRevision = {
    id: crypto.randomUUID(),
    checkpointID: checkpoint.id,
    sequence: 2,
    previousID: first.id,
    archive: await capture("second.backup"),
  }
  const races = await Promise.allSettled([
    stores().checkpoints.publishFiles(lease, second),
    stores().checkpoints.publishFiles(lease, { ...second, id: crypto.randomUUID() }),
  ])
  equal(races.filter((item) => item.status === "fulfilled").length, 1)
  equal(races.filter((item) => item.status === "rejected").length, 1)
  const latest = (await stores().checkpoints.readFiles(scope))!
  equal(latest.data.sequence, 2)
  equal(latest.data.archive, second.archive)
  await rejects(stores().checkpoints.publishFiles(lease, first), "conflict")
  await rejects(
    stores().history.publishFiles(lease, { ...second, id: crypto.randomUUID(), sequence: 3, previousID: first.id }),
    "conflict",
  )
  equal((await stores().history.checkpoint(scope))?.data, checkpoint)
  // Stale restoration must not claim writer authority over newer filesystem data.
  for (const filesRevisionID of [undefined, first.id, crypto.randomUUID()]) {
    await rejects(
      stores().history.claim(scope, {
        expectedEpoch: 1,
        writerID: "writer_stale_restore",
        checkpointID: checkpoint.id,
        filesRevisionID,
      }),
      "conflict",
    )
    equal(await stores().history.epoch(scope), 1)
  }
  const other = { accountID: "acc_files_other", workspaceID: scope.workspaceID }
  equal(await stores().history.fileRevision(other), undefined)
  const otherLease = await stores().history.claim(other, { expectedEpoch: 0, writerID: "writer_other" })
  await rejects(stores().checkpoints.publishFiles(otherLease, first), "not_found")
  equal(await stores().history.fileRevision(other), undefined)
  await platform.dispose()
  platform = undefined
  platform = await start()
  equal(await stores().checkpoints.readFiles(scope), latest)
  const request = (request: Request) =>
    native.handleCheckpointOutbound(
      request,
      {
        ...env(),
        MONGOLGPT_RUNTIME_BACKUP_KEYS: masterJSON,
      },
      { params: scope },
    )
  const fresh = join(root, "replacement")
  await mkdir(fresh)
  const restored = await native.CloudStartup.bootstrap({ root: fresh, request })
  equal(restored?.filesRevisionID, latest.data.id)
  equal(restored?.files, second.archive)
  equal(await readFile(join(fresh, "synthetic/data.bin")), Buffer.from([255, 10, 0, 127]))
  equal(await readFile(join(fresh, "synthetic/new.txt"), "utf8"), "new file after checkpoint")
  equal((await readdir(join(fresh, "synthetic"))).includes("transcript.txt"), false)
  const client = native.createCloudHistory({
    checkpointID: restored!.id,
    filesRevisionID: restored!.filesRevisionID,
    request: async (request) => native.handleHistoryOutbound(request, env(), { params: scope }),
  })
  await native.Effect.runPromise(client.initialize)
  equal(await stores().history.epoch(scope), 2)
  await rejects(
    stores().checkpoints.publishFiles(lease, {
      ...second,
      sequence: 3,
      previousID: latest.data.id,
      id: crypto.randomUUID(),
    }),
    "fenced",
  )
  equal(await stores().history.fileRevision(scope), latest)
  const badDownload = await request(
    new Request("http://checkpoint.mongolgpt.internal/v1/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpointID: checkpoint.id, kind: "files", filesRevisionID: first.id }),
    }),
  )
  equal(badDownload.status, 409)
  await platform.env.DB.prepare(
    "UPDATE runtime_file_revision SET digest = ? WHERE account_id = ? AND workspace_id = ? AND revision_id = ?",
  )
    .bind("0".repeat(64), scope.accountID, scope.workspaceID, latest.data.id)
    .run()
  await rejects(stores().checkpoints.readFiles(scope), "unavailable")
  const corruptBootstrap = await request(
    new Request("http://checkpoint.mongolgpt.internal/v1/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  )
  equal(corruptBootstrap.status, 503)
  await platform.env.DB.prepare(
    "UPDATE runtime_file_revision SET digest = ? WHERE account_id = ? AND workspace_id = ? AND revision_id = ?",
  )
    .bind(latest.digest, scope.accountID, scope.workspaceID, latest.data.id)
    .run()
  const raceLease = await stores().history.claim(scope, {
    expectedEpoch: 2,
    writerID: "writer_publish_claim_race",
    checkpointID: checkpoint.id,
    filesRevisionID: latest.data.id,
  })
  const proposal = { ...second, id: crypto.randomUUID(), sequence: 3, previousID: latest.data.id }
  const racedRoot = join(root, "raced-replacement")
  await mkdir(racedRoot)
  assertions++
  await assert.rejects(
    native.CloudStartup.bootstrap({
      root: racedRoot,
      request: async (incoming) => {
        const response = await request(incoming)
        if (new URL(incoming.url).pathname === "/v1/bootstrap")
          await stores().checkpoints.publishFiles(raceLease, proposal)
        return response
      },
    }),
    /Cloud ажлын талбарыг/,
  )
  equal(await readdir(racedRoot), [])
  equal(
    (await readdir(root)).some((name) => name.startsWith(".mongolgpt-startup-")),
    false,
  )
  equal(await stores().history.epoch(scope), 3)
  const racedProposal = { ...second, id: crypto.randomUUID(), sequence: 4, previousID: proposal.id }
  const admissionRace = await Promise.allSettled([
    stores().checkpoints.publishFiles(raceLease, racedProposal),
    stores().history.claim(scope, {
      expectedEpoch: 3,
      writerID: "writer_replacement_race",
      checkpointID: checkpoint.id,
      filesRevisionID: proposal.id,
    }),
  ])
  equal(admissionRace.filter((item) => item.status === "fulfilled").length, 1)
  equal(admissionRace.filter((item) => item.status === "rejected").length, 1)
  equal(
    (await stores().history.fileRevision(scope))?.data.id,
    admissionRace[0].status === "fulfilled" ? racedProposal.id : proposal.id,
  )
  equal(await stores().history.epoch(scope), admissionRace[0].status === "fulfilled" ? 3 : 4)
  key.fill(0)
  console.log(`FILE_REVISION_RESULT ${JSON.stringify({ ok: true, assertions })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), root)
  if (!inside || isAbsolute(inside) || inside.startsWith("..") || !inside.startsWith("mongolgpt-file-revision-"))
    throw new Error("Unsafe fixture cleanup")
  await rm(root, { recursive: true, force: true })
}
