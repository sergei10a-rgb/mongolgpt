import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"

const root = await mkdtemp(join(tmpdir(), "mongolgpt-postcommit-integration-"))
const masters = JSON.stringify({ synthetic_postcommit: Buffer.alloc(32, 9).toString("base64") })
const testMasterSecret = "checkpoint-postcommit-test-secret-32-bytes"
let assertions = 0
const equal = (actual: unknown, expected: unknown) => {
  assertions++
  assert.deepEqual(actual, expected)
}
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>>> | undefined
try {
  for (const name of ["data", "config", "cache", "state"])
    process.env[`XDG_${name.toUpperCase()}_HOME`] = join(root, name)
  process.env.MONGOLGPT_RUNTIME_SECRET = testMasterSecret
  const native: typeof import("./fixtures/history-native.ts") = await import(pathToFileURL(process.argv[2]).href)
  platform = await getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>({
    configPath: fileURLToPath(new URL("./fixtures/history-d1.jsonc", import.meta.url)),
    persist: { path: join(root, "platform") },
    remoteBindings: false,
    envFiles: [],
  })
  for (const name of [
    "0001_history.sql",
    "0002_history_checkpoint.sql",
    "0003_file_revision.sql",
    "0004_account_retirement.sql",
    "0005_backup_write_fences.sql",
  ])
    for (const sql of unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")))
      await platform.env.DB.prepare(sql).run()

  for (const lostReceipt of [false, true]) {
    const scope = { accountID: "acc_postcommit", workspaceID: `wrk_${lostReceipt ? "lost" : "success"}` }
    const env = {
      HISTORY: platform.env.DB as unknown as NonNullable<
        Parameters<typeof native.handleCheckpointOutbound>[1]["HISTORY"]
      >,
      RUNTIME_BACKUPS: platform.env.BACKUPS as unknown as NonNullable<
        Parameters<typeof native.handleCheckpointOutbound>[1]["RUNTIME_BACKUPS"]
      >,
      MONGOLGPT_RUNTIME_BACKUP_KEYS: masters,
      MONGOLGPT_RUNTIME_SECRET: testMasterSecret,
    }
    const request = await native.createRuntimeCheckpointClient({
      secret: testMasterSecret,
      scope,
      request: (input) => native.handleCheckpointOutbound(input, env, { params: scope }),
    })
    const history = async (input: Request) => native.handleHistoryOutbound(input, env, { params: scope })
    const store = native.createHistoryStore(
      platform.env.DB as unknown as Parameters<typeof native.createHistoryStore>[0],
    )
    const workspace = join(root, scope.workspaceID)
    await mkdir(workspace)
    const checkpoint = await native.CloudBaseline.publish({ root: workspace, request })
    await native.CloudStartup.bootstrap({ root: workspace, request })
    await writeFile(join(workspace, "tool.txt"), "workspace alongside committed SQLite")
    const filename = join(workspace, ".mongolgpt/runtime.sqlite")
    let lease: { epoch: number; writerID: string } | undefined
    let captures = 0
    let notified = 0
    let returned = false
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const publication = native
      .postcommitProjection({
        filename,
        checkpoint,
        notify: () => notified++,
        cloud: {
          checkpointID: checkpoint.id,
          request: history,
          workspace: {
            register: async (value) => {
              lease = value
            },
            publish: async (signal) => {
              captures++
              assert.ok(lease)
              // No other writer exists in this fixture. Linux cgroup freezing is
              // covered by the separate root-supervisor process integration.
              await native.CloudFiles.publish({
                root: workspace,
                checkpointID: checkpoint.id,
                lease,
                signal: signal ?? new AbortController().signal,
                request: async (input) => {
                  const response = await request(input)
                  if (new URL(input.url).pathname === "/v1/publish-files" && response.status === 200) {
                    entered.resolve()
                    await release.promise
                    if (lostReceipt) throw new Error("Synthetic lost postcommit acknowledgement")
                  }
                  return response
                },
              })
            },
          },
        },
      })
      .then((result) => {
        returned = true
        return result
      })
    let result: Awaited<typeof publication>
    try {
      await Promise.race([
        entered.promise,
        publication.then(() => {
          throw new Error("Publication returned before paired receipt")
        }),
      ])
      equal(returned, false)
      equal(notified, 0)
      equal(captures, 1)
      equal(await store.epoch(scope), 2)
      const local = new DatabaseSync(filename, { readOnly: true })
      try {
        equal(local.prepare("SELECT value FROM native_postcommit").get()?.value, "private committed state")
        equal(local.prepare("SELECT id FROM event").get()?.id, "evt_postcommit")
      } finally {
        local.close()
      }
      release.resolve()
      result = await publication
    } finally {
      release.resolve()
      await publication
    }
    equal(result.accepted, !lostReceipt)
    equal(result.admitted, !lostReceipt)
    equal(notified, lostReceipt ? 0 : 1)
    equal(captures, 1)
    equal(
      result.rows.map((row) => row.value),
      ["private committed state"],
    )
    equal(
      result.events.map((event) => event.id),
      ["evt_postcommit"],
    )
    equal((await store.checkpoint(scope))?.data, checkpoint)

    const replacement = join(root, `${scope.workspaceID}_replacement`)
    await mkdir(replacement)
    const restored = await native.CloudStartup.bootstrap({ root: replacement, request })
    assert.ok(restored?.filesRevisionID)
    assertions++
    equal(restored.resume, {})
    equal(restored.inventory, checkpoint.inventory)
    equal(await readFile(join(replacement, "tool.txt"), "utf8"), "workspace alongside committed SQLite")
    const recovered = await native.postcommitProjection({
      filename: join(replacement, ".mongolgpt/runtime.sqlite"),
      checkpoint,
      resume: true,
      notify: () => {
        throw new Error("Recovery must not notify live observers")
      },
      cloud: { checkpointID: checkpoint.id, filesRevisionID: restored.filesRevisionID, request: history },
    })
    equal(recovered.accepted, true)
    equal(recovered.admitted, true)
    equal(recovered.rows, result.rows)
    equal(recovered.events, result.events)
    equal(recovered.projects, result.projects)
    equal(await store.epoch(scope), 3)
  }
  console.log(`POSTCOMMIT_RESULT ${JSON.stringify({ ok: true, assertions })}`)
} finally {
  await platform?.dispose()
  const inside = relative(tmpdir(), root)
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Postcommit cleanup escaped temp root")
  await rm(root, { recursive: true, force: true })
}
