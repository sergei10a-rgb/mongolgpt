import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { link, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CloudFiles } from "@mongolgpt/core/database/cloud-files"
import { CloudBaseline } from "@mongolgpt/core/database/cloud-baseline"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { cloudBaselineStore } from "./fixture/cloud-baseline-store"
import { tmpdir } from "./fixture/tmpdir"

const lease = { epoch: 2, writerID: "writer_native_pair" }

describe("committed native WAL and file pairs", () => {
  let fixture: Awaited<ReturnType<typeof nativePair>> | undefined

  beforeEach(async () => {
    fixture = await nativePair()
  }, 30_000)

  afterEach(async () => {
    await fixture?.temp[Symbol.asyncDispose]()
    fixture = undefined
  }, 15_000)

  test("publishes committed native WAL and files as one revision and restores the latest pair", async () => {
    const { temp, root, store, checkpoint } = fixture!
    const filename = join(root, ".mongolgpt/runtime.sqlite")
    const database = new Database(filename)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    const start = Date.now()
    let phase = "database"
    try {
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE native_state (value TEXT NOT NULL)",
      )
      for (const sequence of [1, 2]) {
        database.exec("DELETE FROM native_state")
        database.query("INSERT INTO native_state VALUES (?)").run(`committed-${sequence}`)
        await writeFile(join(root, "state.txt"), `file-${sequence}`)
        expect((await stat(`${filename}-wal`)).size).toBeGreaterThan(0)
        const previous = store.filesRevision
        const calls = store.calls.length
        // An open transaction is not part of a committed logical SQLite snapshot.
        database.exec("BEGIN IMMEDIATE")
        database.query("UPDATE native_state SET value = ?").run("uncommitted")
        phase = `publish-${sequence}`
        const receipt = await CloudFiles.publish({
          root,
          checkpointID: checkpoint.id,
          lease,
          signal: controller.signal,
          request: store.request,
        })
        database.exec("ROLLBACK")
        expect(store.calls.slice(calls)).toEqual(["/v1/bootstrap", "/v1/upload", "/v1/upload", "/v1/publish-files"])
        expect(receipt.data.sequence).toBe(sequence)
        expect(receipt.data.previousID).toBe(previous?.id ?? null)
        expect(receipt.data.sqlite).toBeDefined()
        expect(receipt.data.sqlite!.backupID).not.toBe(receipt.data.archive.backupID)
        expect(store.checkpoint).toEqual(checkpoint)
        const replacement = join(temp.path, `replacement-${sequence}`)
        await mkdir(replacement)
        phase = `restore-${sequence}`
        const baseline = await CloudStartup.bootstrap({
          root: replacement,
          request: store.request,
          signal: controller.signal,
        })
        phase = `verify-${sequence}`
        expect(baseline?.sqlite).toEqual(checkpoint.sqlite)
        expect(baseline?.inventory).toEqual(checkpoint.inventory)
        expect(baseline?.filesRevisionID).toBe(receipt.data.id)
        expect(baseline?.resume).toEqual({})
        expect(await readFile(join(replacement, "state.txt"), "utf8")).toBe(`file-${sequence}`)
        const restored = new Database(join(replacement, ".mongolgpt/runtime.sqlite"), { readonly: true })
        try {
          expect(restored.query("SELECT value FROM native_state").all()).toEqual([{ value: `committed-${sequence}` }])
          expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
        } finally {
          restored.close()
        }
      }
    } catch (error) {
      console.error("NATIVE_PAIR_FAILURE", { phase, elapsedMs: Date.now() - start, aborted: controller.signal.aborted })
      throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
      database.close()
    }
  }, 30_000)
})

// Real Windows ACL work belongs to a separately bounded fixture. Abort the
// restore before Bun tears down the test so it cannot leak into the next case.
async function nativePair() {
  const temp = await tmpdir()
  const root = join(temp.path, "workspace")
  const store = cloudBaselineStore()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    await mkdir(root)
    const checkpoint = await CloudBaseline.publish({ root, request: store.request, signal: controller.signal })
    await CloudStartup.bootstrap({ root, request: store.request, signal: controller.signal })
    return { temp, root, store, checkpoint }
  } catch (error) {
    await temp[Symbol.asyncDispose]()
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

describe("failed native archive pair publication", () => {
  let fixture: Awaited<ReturnType<typeof acceptedPair>> | undefined

  // Windows ACL subprocesses make real baseline/restore setup substantial.
  // Give setup its own bound, and abort each phase before Bun's outer timeout.
  beforeEach(async () => {
    fixture = await acceptedPair()
  }, 30_000)

  afterEach(async () => {
    await fixture?.temp[Symbol.asyncDispose]()
    fixture = undefined
  }, 15_000)

  test("a failed second archive upload never publishes a partial revision", async () => {
    const { temp, root, store, checkpoint, accepted } = fixture!
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      await writeFile(join(root, "state.txt"), "not accepted")
      for (const mode of ["unavailable", "wrong hash"]) {
        let uploads = 0
        const calls = store.calls.length
        await expect(
          CloudFiles.publish({
            root,
            checkpointID: checkpoint.id,
            lease,
            signal: controller.signal,
            request: async (request) => {
              if (new URL(request.url).pathname !== "/v1/upload" || ++uploads !== 2) return store.request(request)
              if (mode === "unavailable") return new Response(null, { status: 503 })
              const receipt = (await (await store.request(request)).json()) as Record<string, unknown>
              return Response.json({ ...receipt, sha256: "0".repeat(64) })
            },
          }),
        ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
        expect(uploads).toBe(2)
        expect(store.calls.slice(calls)).not.toContain("/v1/publish-files")
        expect(store.filesRevision).toEqual(accepted.data)
      }
      const replacement = join(temp.path, "replacement")
      await mkdir(replacement)
      await CloudStartup.bootstrap({ root: replacement, request: store.request, signal: controller.signal })
      expect(await readFile(join(replacement, "state.txt"), "utf8")).toBe("accepted")
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }, 30_000)
})

async function acceptedPair() {
  const temp = await tmpdir()
  const root = join(temp.path, "workspace")
  const store = cloudBaselineStore()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    await mkdir(root)
    const checkpoint = await CloudBaseline.publish({ root, request: store.request, signal: controller.signal })
    await CloudStartup.bootstrap({ root, request: store.request, signal: controller.signal })
    await writeFile(join(root, "state.txt"), "accepted")
    const accepted = await CloudFiles.publish({
      root,
      checkpointID: checkpoint.id,
      lease,
      signal: controller.signal,
      request: store.request,
    })
    return { temp, root, store, checkpoint, accepted }
  } catch (error) {
    await temp[Symbol.asyncDispose]()
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

test("rejects native database hardlinks before capturing or uploading", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(root)
  const store = cloudBaselineStore()
  const checkpoint = await CloudBaseline.publish({ root, request: store.request })
  await CloudStartup.bootstrap({ root, request: store.request })
  await link(join(root, ".mongolgpt/runtime.sqlite"), join(temp.path, "outside.sqlite"))
  const calls = store.calls.length
  await expect(
    CloudFiles.publish({
      root,
      checkpointID: checkpoint.id,
      lease,
      signal: AbortSignal.timeout(20_000),
      request: store.request,
    }),
  ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
  expect(store.calls.slice(calls)).toEqual(["/v1/bootstrap"])
  expect(store.filesRevision).toBeUndefined()
}, 30_000)

test.skipIf(process.platform === "win32")(
  "rejects native WAL symlinks before opening SQLite",
  async () => {
    await using temp = await tmpdir()
    const root = join(temp.path, "workspace")
    await mkdir(root)
    const store = cloudBaselineStore()
    const checkpoint = await CloudBaseline.publish({ root, request: store.request })
    await CloudStartup.bootstrap({ root, request: store.request })
    const outside = join(temp.path, "outside-wal")
    await writeFile(outside, "must not be read as a native WAL")
    await symlink(outside, join(root, ".mongolgpt/runtime.sqlite-wal"))
    const calls = store.calls.length
    await expect(
      CloudFiles.publish({
        root,
        checkpointID: checkpoint.id,
        lease,
        signal: AbortSignal.timeout(20_000),
        request: store.request,
      }),
    ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
    expect(store.calls.slice(calls)).toEqual(["/v1/bootstrap"])
    expect(await readFile(outside, "utf8")).toBe("must not be read as a native WAL")
  },
  30_000,
)
