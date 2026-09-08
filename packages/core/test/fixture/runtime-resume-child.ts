import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { writeSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { CloudWorkspace } from "@mongolgpt/core/database/cloud-workspace"
import { createCloudHistory } from "@mongolgpt/core/event/cloud-history"

const root = process.argv[2]
const remoteEpoch = Number(process.argv[3])
assert.equal(process.getuid!(), 10001)
await CloudStartup.prepare({ root })
const baseline = CloudStartup.baseline()!
const workspace = CloudWorkspace.connect()
const cloud = createCloudHistory({
  checkpointID: baseline.id,
  expectedEpoch: baseline.resume?.expectedEpoch,
  workspace,
  request: async (request) => {
    if (request.url.endsWith("/epoch")) return Response.json({ epoch: remoteEpoch })
    assert.ok(request.url.endsWith("/claim"))
    const body = (await request.json()) as { expectedEpoch: number; writerID: string }
    assert.equal(body.expectedEpoch, remoteEpoch)
    return Response.json({ epoch: remoteEpoch + 1, writerID: body.writerID })
  },
})
try {
  await Effect.runPromise(cloud.initialize)
  const database = new Database(join(root, ".mongolgpt/runtime.sqlite"))
  try {
    assert.ok(database.query("SELECT name FROM sqlite_master WHERE name = 'session_input'").get())
    if (!baseline.resume) {
      database.exec("CREATE TABLE resume_probe (value TEXT NOT NULL)")
      database.query("INSERT INTO resume_probe VALUES (?)").run("keep non-journal state")
      await writeFile(join(root, "pending-work.txt"), "keep uncheckpointed files")
    }
    assert.deepEqual(database.query("SELECT value FROM resume_probe").all(), [{ value: "keep non-journal state" }])
    assert.equal(await readFile(join(root, "pending-work.txt"), "utf8"), "keep uncheckpointed files")
    console.log(
      JSON.stringify({
        resume: !!baseline.resume,
        previousEpoch: baseline.resume?.expectedEpoch,
        epoch: remoteEpoch + 1,
      }),
    )
  } finally {
    database.close()
  }
} catch (error) {
  writeSync(2, String(error))
  process.exitCode = 1
} finally {
  workspace.close()
}
