export * as CloudRestore from "./cloud-restore"

import { lstat, mkdtemp, mkdir, link, unlink, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Layer, Schema } from "effect"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { DatabaseBackup } from "./backup"
import { protectBackupPath } from "./backup-permissions"
import { DatabaseCheckpoint } from "./checkpoint"
import { WorkspaceRestore } from "./workspace-restore"
import { Database } from "./database"
import { EventV2 } from "../event"
import { createCloudHistory } from "../event/cloud-history"
import { createCloudRecovery } from "../event/cloud-recovery"
import { ProjectHistory } from "../project/history"
import { SessionProjector } from "../session/projector"

export class RestoreError extends Schema.TaggedErrorClass<RestoreError>()("CloudRuntimeRestoreError", {
  message: Schema.String,
}) {}

interface Input {
  parent: string
  checkpoint: CloudCheckpoint.Checkpoint
  sqlite: { source: string; key: Uint8Array }
  files: { source: string; key: Uint8Array }
}

export interface Restored {
  directory: string
  database: string
  checkpoint: CloudCheckpoint.Checkpoint
  report: DatabaseBackup.Report
  files: { files: number; directories: number; bytes: number }
}

/** A new private generation, never a replacement of a running workspace. Both
 * archives must be fetched from the trusted checkpoint's tenant-scoped R2 store.
 * Caller must finish createRuntime().recovery before exposing a server or tools.
 */
export function restore(input: Input) {
  return Effect.callback<Restored, RestoreError>((resume, signal) => {
    const keys = { sqlite: new Uint8Array(input.sqlite.key), files: new Uint8Array(input.files.key) }
    const sources = { sqlite: resolve(input.sqlite.source), files: resolve(input.files.source) }
    const parent = resolve(input.parent)
    const pending = (async () => {
      let generation: string | undefined
      let retained = false
      try {
        const encoded = JSON.stringify(input.checkpoint)
        if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024) throw new Error()
        const checkpoint = Schema.decodeUnknownSync(CloudCheckpoint.Checkpoint)(
          Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(encoded),
          { onExcessProperty: "error" },
        )
        for (let current = parent; ; current = dirname(current)) {
          const info = await lstat(current)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
          if (current === dirname(current)) break
        }
        signal.throwIfAborted()
        generation = await mkdtemp(join(parent, ".mongolgpt-restore-"))
        await protectBackupPath(generation, "directory")
        const sqlite = join(generation, "native.sqlite")
        const manifest = join(generation, "files.sqlite")
        const report = await Effect.runPromise(
          DatabaseBackup.restore({ source: sources.sqlite, destination: sqlite, key: keys.sqlite }),
          { signal },
        )
        checkReceipt(report, checkpoint.sqlite)
        const inventory = await Effect.runPromise(DatabaseCheckpoint.inspect({ source: sqlite, expected: report }), {
          signal,
        })
        if (!sameInventory(inventory, checkpoint.inventory)) throw new Error()
        const fileReport = await Effect.runPromise(
          DatabaseBackup.restore({ source: sources.files, destination: manifest, key: keys.files }),
          { signal },
        )
        checkReceipt(fileReport, checkpoint.files)
        const directory = join(generation, "workspace")
        const files = await Effect.runPromise(
          WorkspaceRestore.materialize({ source: manifest, expected: fileReport, destination: directory }),
          { signal },
        )
        const data = join(directory, ".mongolgpt")
        const existing = await lstat(data).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error()
        if (!existing) {
          await mkdir(data, { mode: 0o700 })
          await protectBackupPath(data, "directory")
        }
        const database = join(data, "runtime.sqlite")
        // Atomic no-clobber publication, including against a reserved-path collision
        // inside the file archive. The generation remains inaccessible to the app.
        await link(sqlite, database)
        await unlink(sqlite)
        await unlink(manifest)
        signal.throwIfAborted()
        retained = true
        return { directory, database, checkpoint, report, files }
      } finally {
        keys.sqlite.fill(0)
        keys.files.fill(0)
        if (generation && !retained) {
          const inside = relative(parent, generation)
          if (!inside || isAbsolute(inside) || inside.startsWith("..") || !inside.startsWith(".mongolgpt-restore-"))
            throw new Error()
          await rm(generation, { recursive: true, force: true })
        }
      }
    })().then(
      (value) => resume(Effect.succeed(value)),
      () =>
        resume(
          Effect.fail(
            new RestoreError({
              message: "Cloud ажлын талбарыг нөөцөөс сэргээж чадсангүй. Өмнөх өгөгдлийг өөрчлөөгүй.",
            }),
          ),
        ),
    )
    return Effect.promise(() => pending)
  })
}

/** Connect the actual verified SQLite generation to native projectors and the
 * cloud journal. No model execution, filesystem tool or HTTP server starts here.
 */
export function createRuntime(restored: Restored, request?: (request: Request) => Promise<Response>) {
  const cloud = createCloudHistory({ request, checkpointID: restored.checkpoint.id })
  const recovery = createCloudRecovery(cloud, restored.checkpoint)
  const filename = resolve(restored.database)
  const expected = structuredClone(restored.report)
  const inventory = structuredClone(restored.checkpoint.inventory)
  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const observed = yield* DatabaseCheckpoint.inspect({ source: filename, expected })
      if (!sameInventory(observed, inventory))
        return yield* Effect.die(
          new RestoreError({ message: "Сэргээсэн өгөгдөл нөөцийн баталгаатай тохирохгүй байна." }),
        )
      return Layer.mergeAll(ProjectHistory.layer, SessionProjector.layer).pipe(
        Layer.provideMerge(EventV2.layerWith(recovery.eventOptions)),
        Layer.provideMerge(Database.layerFromPath(filename)),
      )
    }),
  )
  return { layer, recovery: recovery.recover, admission: recovery.admission }
}

function checkReceipt(report: DatabaseBackup.Report, expected: CloudCheckpoint.Archive) {
  if (report.bytes !== expected.plaintext.bytes || report.sha256 !== expected.plaintext.sha256) throw new Error()
}

function sameInventory(actual: CloudCheckpoint.Inventory, expected: CloudCheckpoint.Inventory) {
  return isDeepStrictEqual(actual, expected)
}
