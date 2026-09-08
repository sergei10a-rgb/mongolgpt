import { expect, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { CloudBaseline } from "@mongolgpt/core/database/cloud-baseline"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { Database } from "@mongolgpt/core/database/database"
import { DatabaseCheckpoint } from "@mongolgpt/core/database/checkpoint"
import { cloudBaselineStore } from "./fixture/cloud-baseline-store"
import { tmpdir } from "./fixture/tmpdir"

test("publishes native migrated SQLite and restores it before a fresh workspace can run", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(join(root, ".mongolgpt/data"), { recursive: true })
  const store = cloudBaselineStore()
  const checkpoint = await CloudBaseline.publish({ root, request: store.request })
  expect(checkpoint.inventory.projects).toEqual([])
  expect(checkpoint.inventory.sessions).toEqual([])
  expect(checkpoint.inventory.tombstonesRecorded).toBe(true)
  expect(checkpoint.sqlite.backupID).not.toBe(checkpoint.files.backupID)
  expect(await readdir(join(root, ".mongolgpt"))).toEqual(["data"])
  expect(await readdir(temp.path)).toEqual(["workspace"])
  expect(store.calls).toEqual(["/v1/begin", "/v1/upload", "/v1/upload", "/v1/publish"])
  expect(await CloudStartup.bootstrap({ root, request: store.request })).toEqual(checkpoint)
  const inventory = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const result = yield* DatabaseCheckpoint.scan(database.db)
      const migrations = yield* database.db.all<{ count: number }>("SELECT count(*) AS count FROM migration")
      expect(migrations[0].count).toBeGreaterThan(0)
      return result
    }).pipe(Effect.provide(Database.layerFromPath(join(root, ".mongolgpt/runtime.sqlite"))), Effect.scoped),
  )
  expect(inventory.counts).toEqual({ events: 0, tombstones: 0 })
  expect(await readdir(temp.path)).toEqual(["workspace"])
}, 30_000)

test("rejects a nonempty workspace and pre-aborted initialization without a writer claim", async () => {
  await using temp = await tmpdir()
  await writeFile(join(temp.path, "user.txt"), "keep")
  const store = cloudBaselineStore()
  for (const signal of [undefined, AbortSignal.abort()]) {
    await expect(CloudBaseline.publish({ root: temp.path, request: store.request, signal })).rejects.toBeInstanceOf(
      CloudBaseline.BaselineError,
    )
  }
  expect(store.calls).toEqual([])
  expect(await readFile(join(temp.path, "user.txt"), "utf8")).toBe("keep")
})

test("rejects mismatched lease, invalid keys, and HTML before creating native archives", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(root)
  for (const failure of ["writer", "key", "html"]) {
    const store = cloudBaselineStore()
    await expect(
      CloudBaseline.publish({
        root,
        request: async (request) => {
          const response = await store.request(request)
          if (failure === "html") return new Response("not json")
          const data = (await response.json()) as { key: string; lease: { writerID: string } }
          if (failure === "writer") data.lease.writerID = "another"
          if (failure === "key") data.key = Buffer.alloc(31).toString("base64")
          return Response.json(data)
        },
      }),
    ).rejects.toBeInstanceOf(CloudBaseline.BaselineError)
    expect(store.calls).toEqual(["/v1/begin"])
    expect(await readdir(temp.path)).toEqual(["workspace"])
  }
})

for (const failure of ["upload", "receipt", "lost-ack", "abort"]) {
  test(`never acknowledges ${failure} and cleans private native staging`, async () => {
    await using temp = await tmpdir()
    const root = join(temp.path, "workspace")
    await mkdir(root)
    const store = cloudBaselineStore()
    const abort = new AbortController()
    await expect(
      CloudBaseline.publish({
        root,
        signal: abort.signal,
        request: async (request) => {
          const response = await store.request(request)
          const route = new URL(request.url).pathname
          if (route === "/v1/upload" && failure === "upload") {
            const value = (await response.json()) as { sha256: string }
            value.sha256 = "0".repeat(64)
            return Response.json(value)
          }
          if (route === "/v1/publish") {
            if (failure === "receipt") return Response.json({ data: store.checkpoint, digest: "invalid" })
            if (failure === "lost-ack") throw new Error("synthetic response lost after commit")
            if (failure === "abort") abort.abort()
          }
          return response
        },
      }),
    ).rejects.toBeInstanceOf(CloudBaseline.BaselineError)
    expect(await readdir(root)).toEqual([])
    expect(await readdir(temp.path)).toEqual(["workspace"])
    expect(store.calls.filter((route) => route === "/v1/begin")).toHaveLength(1)
    expect(store.calls.filter((route) => route === "/v1/publish")).toHaveLength(failure === "upload" ? 0 : 1)
  }, 30_000)
}
