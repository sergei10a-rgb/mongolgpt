import assert from "node:assert/strict"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { Readable } from "node:stream"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

const root = await mkdtemp(join(tmpdir(), "mongolgpt-checkpoint-startup-"))
const scope = { accountID: "acc_startup", workspaceID: "wrk_startup" }
const testMasterSecret = "checkpoint-startup-test-secret-32-bytes"
let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; BACKUPS: R2Bucket }>>> | undefined
let assertions = 0
const equal = (actual: unknown, expected: unknown) => {
  assertions++
  assert.deepEqual(actual, expected)
}
let corrupt = false
const calls: string[] = []
const proxy = createServer()
try {
  for (const name of ["data", "config", "cache", "state"]) {
    process.env[`XDG_${name.toUpperCase()}_HOME`] = join(root, name)
  }
  process.env.MONGOLGPT_RUNTIME_SECRET = testMasterSecret
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
  ]) {
    const sql = await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8")
    for (const statement of unstable_splitSqlQuery(sql)) await platform.env.DB.prepare(statement).run()
  }
  const native: typeof import("./fixtures/history-native.ts") = await import(pathToFileURL(process.argv[2]).href)
  const db = platform.env.DB as unknown as NonNullable<Parameters<typeof native.handleCheckpointOutbound>[1]["HISTORY"]>
  const bucket = platform.env.BACKUPS as unknown as NonNullable<
    Parameters<typeof native.handleCheckpointOutbound>[1]["RUNTIME_BACKUPS"]
  >
  const fixture = await native.createCheckpointFixture(root, scope, join(root, "ready/workspace"))
  const history = native.createHistoryStore(db)
  const backups = native.createRuntimeBackupStore(bucket)
  const refs = {} as Record<"sqlite" | "files", CloudCheckpoint.Archive>
  for (const kind of ["sqlite", "files"] as const) {
    const bytes = await readFile(kind === "sqlite" ? fixture.sqliteArchive : fixture.filesArchive)
    const saved = await backups.save(scope, { keyID: fixture.input[kind].keyID, body: new Response(bytes).body! })
    refs[kind] = {
      backupID: saved.backupID,
      keyID: saved.keyID,
      bytes: saved.bytes,
      sha256: saved.sha256,
      plaintext: fixture.input[kind].plaintext,
    }
  }
  const checkpoint: CloudCheckpoint.Checkpoint = { id: fixture.input.id, inventory: fixture.input.inventory, ...refs }
  const lease = await history.claim(scope, { expectedEpoch: 0, writerID: "writer_startup_baseline" })
  await native
    .createRuntimeCheckpointStore(db, bucket, { [refs.sqlite.keyID]: fixture.master })
    .publish(lease, checkpoint)
  const key = native.deriveRuntimeBackupKey(scope, refs.files.keyID, fixture.master)
  try {
    const source = await native.restoreCheckpoint({
      parent: root,
      checkpoint,
      sqlite: { source: fixture.sqliteArchive, key },
      files: { source: fixture.filesArchive, key },
    })
    await writeFile(join(source.directory, "synthetic/transcript.txt"), "file revision after checkpoint")
    const archive = join(root, "latest-files.backup")
    const captured = await native.Effect.runPromise(
      native.WorkspaceCapture.create({
        source: source.directory,
        destination: archive,
        key,
        exclude: [".mongolgpt/runtime.sqlite"],
      }),
    )
    const saved = await backups.save(scope, {
      keyID: refs.files.keyID,
      body: new Response(await readFile(archive)).body!,
    })
    await native.createRuntimeCheckpointStore(db, bucket, { [refs.files.keyID]: fixture.master }).publishFiles(lease, {
      id: crypto.randomUUID(),
      checkpointID: checkpoint.id,
      sequence: 1,
      previousID: null,
      archive: {
        backupID: saved.backupID,
        keyID: saved.keyID,
        bytes: saved.bytes,
        sha256: saved.sha256,
        plaintext: { bytes: captured.report.bytes, sha256: captured.report.sha256 },
      },
    })
  } finally {
    key.fill(0)
  }
  const part = {
    id: "evt_startup_delta",
    aggregateID: "ses_checkpoint",
    seq: 3,
    type: "message.part.updated.1",
    data: {
      sessionID: "ses_checkpoint",
      time: 1710000004000,
      part: {
        id: "prt_checkpoint",
        sessionID: "ses_checkpoint",
        messageID: "msg_checkpoint",
        type: "text",
        text: "D1 delta after checkpoint",
      },
    },
  }
  const baseline = await history.read(scope, { checkpointID: checkpoint.id })
  equal(baseline.entries.length, 0)
  await history.append(lease, part)
  const env = {
    HISTORY: db,
    RUNTIME_BACKUPS: bucket,
    MONGOLGPT_RUNTIME_BACKUP_KEYS: JSON.stringify({
      [refs.sqlite.keyID]: Buffer.from(fixture.master).toString("base64"),
    }),
    MONGOLGPT_RUNTIME_SECRET: testMasterSecret,
  }
  const checkpointRequest = await native.createRuntimeCheckpointClient({
    secret: testMasterSecret,
    scope,
    request: (request) => native.handleCheckpointOutbound(request, env, { params: scope }),
  })
  proxy.on("request", async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, "http://127.0.0.1")
      const isCheckpoint = url.pathname.startsWith("/checkpoint/")
      const route = url.pathname.replace(/^\/(checkpoint|history)/, "")
      calls.push(`${isCheckpoint ? "checkpoint" : "history"}${route}`)
      const body = await new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>).text()
      const request = new Request(`http://${isCheckpoint ? "checkpoint" : "history"}.mongolgpt.internal${route}`, {
        method: incoming.method,
        headers: { "content-type": "application/json" },
        body,
      })
      const response = isCheckpoint
        ? await checkpointRequest(request)
        : await native.handleHistoryOutbound(request, { HISTORY: db }, { params: scope })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (corrupt && isCheckpoint && route === "/v1/archive" && response.status === 200) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        bytes[0] ^= 1
        outgoing.end(bytes)
        return
      }
      if (!response.body) {
        outgoing.end()
        return
      }
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(outgoing)
    } catch {
      outgoing.destroy(new Error("Synthetic checkpoint transport failed"))
    }
  })
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  const address = proxy.address()
  assert(address && typeof address !== "string")
  for (const mode of ["ready", "corrupt"] as const) {
    corrupt = mode === "corrupt"
    calls.length = 0
    const directory = join(root, mode)
    await mkdir(directory)
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.argv[3],
      [
        "run",
        "--conditions=browser",
        "test/fixture/checkpoint-startup.ts",
        directory,
        `http://127.0.0.1:${address.port}`,
        mode,
      ],
      {
        cwd: fileURLToPath(new URL("../../mongolgpt", import.meta.url)),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MONGOLGPT_RUNTIME_SECRET: testMasterSecret },
      },
    )
    const output: string[] = []
    const errors: string[] = []
    child.stdout.on("data", (chunk) => output.push(chunk.toString()))
    child.stderr.on("data", (chunk) => errors.push(chunk.toString()))
    const timeout = setTimeout(() => child.kill(), 50_000)
    const result: unknown[] = await once(child, "close").finally(() => clearTimeout(timeout))
    assert.equal(
      result[0],
      0,
      `${mode}: ${calls.join(",")}\n${output.join("").slice(-1000)}\n${errors.join("").slice(-8000)}`,
    )
    assertions++
    equal(output.join("").includes(`CHECKPOINT_CHILD_${mode.toUpperCase()}_PASS`), true)
    equal(calls[0], "checkpoint/v1/bootstrap")
    equal(calls[1], "checkpoint/v1/archive")
    if (mode === "corrupt") {
      equal(calls.length, 2)
      equal(await readdir(join(directory, "workspace")), [])
    } else {
      equal(calls[2], "checkpoint/v1/archive")
      equal(calls[3], "history/v1/epoch")
      equal(calls[4], "history/v1/claim")
      equal(calls[5], "history/v1/read")
      equal(
        await readFile(join(directory, "workspace/synthetic/transcript.txt"), "utf8"),
        "file revision after checkpoint",
      )
      equal(await readFile(join(directory, "workspace/synthetic/data.bin")), Buffer.from([0, 1, 127, 255]))
    }
    equal(
      (await readdir(directory)).some((name) => name.startsWith(".mongolgpt-startup-")),
      false,
    )
  }
  equal(await history.epoch(scope), 2)
  equal((await history.read(scope, { checkpointID: checkpoint.id })).entries.length, 1)
  console.log(`CHECKPOINT_STARTUP_RESULT ${JSON.stringify({ ok: true, assertions })}`)
} finally {
  proxy.closeAllConnections()
  if (proxy.listening)
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))
  await platform?.dispose()
  const inside = relative(tmpdir(), root)
  if (!inside || isAbsolute(inside) || inside.startsWith("..") || !inside.startsWith("mongolgpt-checkpoint-startup-"))
    throw new Error("Unsafe startup fixture cleanup")
  await rm(root, { recursive: true, force: true })
}
