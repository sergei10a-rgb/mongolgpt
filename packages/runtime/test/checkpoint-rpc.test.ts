import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { RuntimeBackupError, deriveRuntimeBackupKey } from "../src/backup"
import { createCheckpointHandler, handleCheckpointOutbound } from "../src/checkpoint-rpc"
import { HistoryError, type HistoryScope } from "../src/history"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

const scope = { accountID: "acc_checkpoint_rpc", workspaceID: "wrk_checkpoint_rpc" } satisfies HistoryScope
const otherScope = { accountID: "acc_checkpoint_other", workspaceID: "wrk_checkpoint_rpc" } satisfies HistoryScope
const url = "http://checkpoint.mongolgpt.internal/v1"
const master = Buffer.from("9b4f5d452df4b2a252956e2a31a8245f5f6453c8849974c1f94e72cd8b5b9466", "hex")
const masterKeyJson = JSON.stringify({ key_checkpoint_rpc: master.toString("base64") })

describe("checkpoint rpc", () => {
  test("fails closed when the internal D1 binding is missing", async () => {
    const response = await handleCheckpointOutbound(request("/bootstrap", {}), {}, { params: scope })

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } })
  })

  test("bootstraps a trusted checkpoint with tenant-derived keys only", async () => {
    const checkpoint = checkpointFixture()
    const handler = createCheckpointHandler(
      { history: historyStore({ checkpoint }), backups: backupStore(checkpoint), masterKeyJson },
      scope,
    )
    const response = await handler(request("/bootstrap", {}))
    const body = (await response.json()) as {
      checkpoint: CloudCheckpoint.Checkpoint
      keys: { sqlite: string; files: string }
    }

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body.checkpoint).toEqual(checkpoint)
    expect(body.keys).toEqual({
      sqlite: canonicalBase64(deriveRuntimeBackupKey(scope, checkpoint.sqlite.keyID, master)),
      files: canonicalBase64(deriveRuntimeBackupKey(scope, checkpoint.files.keyID, master)),
    })
    expect(JSON.stringify(body)).not.toContain(master.toString("base64"))

    const other = (await createCheckpointHandler(
      { history: historyStore({ checkpoint }), backups: backupStore(checkpoint), masterKeyJson },
      otherScope,
    )(request("/bootstrap", {})).then((item) => item.json())) as { keys: { sqlite: string; files: string } }
    expect(other.keys.sqlite).not.toBe(body.keys.sqlite)
  })

  test("keeps prototype-like master entries from affecting valid keys", async () => {
    const checkpoint = checkpointFixture()
    const response = await createCheckpointHandler(
      {
        history: historyStore({ checkpoint }),
        masterKeyJson: JSON.stringify({
          ["__proto__"]: master.toString("base64"),
          key_checkpoint_rpc: master.toString("base64"),
        }),
      },
      scope,
    )(request("/bootstrap", {}))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      keys: { sqlite: canonicalBase64(deriveRuntimeBackupKey(scope, checkpoint.sqlite.keyID, master)) },
    })
  })

  test("returns a null bootstrap only for a brand-new history epoch", async () => {
    const fresh = await createCheckpointHandler(
      { history: historyStore({ checkpoint: undefined, epoch: 0 }), masterKeyJson },
      scope,
    )(request("/bootstrap", {}))
    expect(fresh.status).toBe(200)
    expect((await fresh.json()) as unknown).toEqual({ checkpoint: null })

    const missingBaseline = await createCheckpointHandler(
      { history: historyStore({ checkpoint: undefined, epoch: 2 }), masterKeyJson },
      scope,
    )(request("/bootstrap", {}))
    expect(missingBaseline.status).toBe(409)
    expect(await missingBaseline.json()).toMatchObject({ error: { code: "conflict" } })
  })

  test("rejects malformed transport and exact-body violations before stores run", async () => {
    await expectInvalid(new Request(`${url}/bootstrap`, { method: "GET", headers: jsonContent() }))
    await expectInvalid(
      new Request(`${url}/bootstrap`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
    )
    await expectInvalid(
      new Request("http://example.invalid/v1/bootstrap", { method: "POST", headers: jsonContent(), body: "{}" }),
    )
    await expectInvalid(
      new Request("http://user@checkpoint.mongolgpt.internal/v1/bootstrap", {
        method: "POST",
        headers: jsonContent(),
        body: "{}",
      }),
    )
    await expectInvalid(request("/bootstrap?x=1", {}))
    await expectInvalid(new Request(`${url}/bootstrap#hash`, { method: "POST", headers: jsonContent(), body: "{}" }))
    await expectInvalid(request("/bootstrap", { extra: true }))
    await expectInvalid(request("/archive", { checkpointID: checkpointFixture().id, kind: "sqlite", scope }))
    await expectInvalid(request("/archive", { checkpointID: checkpointFixture().id, kind: "sqlite", backupID: "x" }))
  })

  test("rejects invalid, oversized, and cancelled request bodies", async () => {
    await expectInvalid(new Request(`${url}/bootstrap`, { method: "POST", headers: jsonContent(), body: "" }))
    await expectInvalid(
      new Request(`${url}/bootstrap`, {
        method: "POST",
        headers: jsonContent(),
        body: new Uint8Array([0xff]),
      }),
    )
    await expectInvalid(
      new Request(`${url}/bootstrap`, {
        method: "POST",
        headers: jsonContent(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4097))
            controller.close()
          },
        }),
      }),
    )

    const controller = new AbortController()
    controller.abort()
    const cancelled = await createCheckpointHandler(
      { history: historyStore({ checkpoint: checkpointFixture() }), masterKeyJson },
      scope,
    )(
      new Request(`${url}/bootstrap`, {
        method: "POST",
        headers: jsonContent(),
        body: "{}",
        signal: controller.signal,
      }),
    )
    expect(cancelled.status).toBe(503)
    expect(await cancelled.json()).toMatchObject({ error: { code: "unavailable" } })
  })

  test("does not await hung request cancellation after timeout or oversize", async () => {
    const checkpoint = checkpointFixture()
    const handler = createCheckpointHandler(
      { history: historyStore({ checkpoint }), masterKeyJson, bodyTimeoutMs: 1 },
      scope,
    )

    const timedOut = await bounded(
      handler(
        new Request(`${url}/bootstrap`, {
          method: "POST",
          headers: jsonContent(),
          body: new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => {})
            },
            cancel() {
              return new Promise(() => {})
            },
          }),
        }),
      ),
    )
    expect(timedOut.status).toBe(503)

    const oversized = await bounded(
      handler(
        new Request(`${url}/bootstrap`, {
          method: "POST",
          headers: jsonContent(),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4097))
            },
            cancel() {
              return new Promise(() => {})
            },
          }),
        }),
      ),
    )
    expect(oversized.status).toBe(400)
  })

  test("rejects invalid master key secrets without leaking private details", async () => {
    for (const secret of [
      undefined,
      "[]",
      JSON.stringify({ "../key": master.toString("base64") }),
      JSON.stringify({ key_checkpoint_rpc: master.toString("base64"), invalid: Buffer.alloc(31).toString("base64") }),
      JSON.stringify({ key_checkpoint_rpc: master.toString("base64").replace(/=+$/, "") }),
      JSON.stringify({ key_checkpoint_rpc: Buffer.alloc(31).toString("base64") }),
      JSON.stringify({ key_checkpoint_rpc: master.toString("base64") }) + " ".repeat(32 * 1024),
    ]) {
      const response = await createCheckpointHandler(
        { history: historyStore({ checkpoint: checkpointFixture() }), masterKeyJson: secret },
        scope,
      )(request("/bootstrap", {}))
      const body = await response.json()
      expect(response.status).toBe(503)
      expect(JSON.stringify(body)).not.toContain(master.toString("base64"))
      expect(JSON.stringify(body)).not.toContain("key_checkpoint_rpc")
    }
  })

  test("streams only the requested accepted archive with manifest checks", async () => {
    const checkpoint = checkpointFixture()
    const store = backupStore(checkpoint)
    const handler = createCheckpointHandler(
      { history: historyStore({ checkpoint }), backups: store, masterKeyJson },
      scope,
    )
    const response = await handler(request("/archive", { checkpointID: checkpoint.id, kind: "files" }))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-length")).toBe(String(checkpoint.files.bytes))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archiveBytes(checkpoint.files.bytes))
    expect(store.opened).toEqual([{ scope, backupID: checkpoint.files.backupID }])
  })

  test("rejects checkpoint id, backup ref, key, hash, and manifest version mismatches", async () => {
    const checkpoint = checkpointFixture()
    const handler = createCheckpointHandler(
      { history: historyStore({ checkpoint }), backups: backupStore(checkpoint), masterKeyJson },
      scope,
    )

    expect((await handler(request("/archive", { checkpointID: crypto.randomUUID(), kind: "sqlite" }))).status).toBe(409)
    for (const patch of [
      { backupID: crypto.randomUUID() },
      { keyID: "key_other" },
      { sha256: "f".repeat(64) },
      { version: 2 },
    ]) {
      const response = await createCheckpointHandler(
        {
          history: historyStore({ checkpoint }),
          backups: backupStore(checkpoint, { sqlite: patch }),
          masterKeyJson,
        },
        scope,
      )(request("/archive", { checkpointID: checkpoint.id, kind: "sqlite" }))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: "conflict" } })
    }
  })

  test("sanitizes store failures and propagates archive stream tamper and cancellation", async () => {
    const checkpoint = checkpointFixture()
    const detail = "private R2 object key"
    const unavailable = await createCheckpointHandler(
      {
        history: historyStore({ checkpoint }),
        backups: {
          open: async () => {
            throw new RuntimeBackupError("not_found")
          },
        },
        masterKeyJson,
      },
      scope,
    )(request("/archive", { checkpointID: checkpoint.id, kind: "sqlite" }))
    expect(unavailable.status).toBe(503)
    expect(JSON.stringify(await unavailable.json())).not.toContain(detail)

    const checkpointMismatch = await bounded(
      createCheckpointHandler(
        {
          history: historyStore({ checkpoint }),
          backups: backupStore(
            checkpoint,
            { sqlite: { sha256: "f".repeat(64) } },
            new ReadableStream<Uint8Array>({
              cancel() {
                return new Promise(() => {})
              },
            }),
          ),
          masterKeyJson,
        },
        scope,
      )(request("/archive", { checkpointID: checkpoint.id, kind: "sqlite" })),
    )
    expect(checkpointMismatch.status).toBe(409)

    const tampered = await createCheckpointHandler(
      {
        history: historyStore({ checkpoint }),
        backups: backupStore(
          checkpoint,
          {},
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
              queueMicrotask(() => controller.error("stream tamper"))
            },
          }),
        ),
        masterKeyJson,
      },
      scope,
    )(request("/archive", { checkpointID: checkpoint.id, kind: "sqlite" }))
    expect(tampered.status).toBe(200)
    try {
      await tampered.arrayBuffer()
      throw new Error("tampered stream unexpectedly completed")
    } catch (error) {
      expect(String(error)).toContain("stream tamper")
    }

    let cancelled = false
    const cancellable = await createCheckpointHandler(
      {
        history: historyStore({ checkpoint }),
        backups: backupStore(
          checkpoint,
          {},
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true
            },
          }),
        ),
        masterKeyJson,
      },
      scope,
    )(request("/archive", { checkpointID: checkpoint.id, kind: "sqlite" }))
    await cancellable.body?.cancel()
    expect(cancelled).toBe(true)
  })

  test("maps history conflicts without leaking implementation details", async () => {
    const response = await createCheckpointHandler(
      {
        history: historyStore({ checkpoint: checkpointFixture(), checkpointError: new HistoryError("conflict") }),
        masterKeyJson,
      },
      scope,
    )(request("/bootstrap", {}))

    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain("SQL")
  })
})

function historyStore(input: {
  checkpoint?: CloudCheckpoint.Checkpoint
  epoch?: number
  checkpointError?: Error
  calls?: string[]
}) {
  const calls = input.calls ?? []
  return {
    calls,
    checkpoint: async (tenant: HistoryScope) => {
      calls.push(`checkpoint:${tenant.accountID}:${tenant.workspaceID}`)
      if (input.checkpointError) throw input.checkpointError
      return input.checkpoint ? { data: input.checkpoint, digest: "1".repeat(64) } : undefined
    },
    epoch: async (tenant: HistoryScope) => {
      calls.push(`epoch:${tenant.accountID}:${tenant.workspaceID}`)
      return input.epoch ?? 0
    },
  }
}

function backupStore(
  checkpoint: CloudCheckpoint.Checkpoint,
  overrides: Partial<Record<"sqlite" | "files", Partial<ArchiveManifest>>> = {},
  stream?: ReadableStream<Uint8Array>,
) {
  const opened = new Array<{ scope: HistoryScope; backupID: string }>()
  return {
    opened,
    open: async (tenant: HistoryScope, backupID: string) => {
      opened.push({ scope: tenant, backupID })
      const selected = checkpoint.sqlite.backupID === backupID ? checkpoint.sqlite : checkpoint.files
      const kind = checkpoint.sqlite.backupID === backupID ? "sqlite" : "files"
      return {
        manifest: {
          version: 1,
          format: "mongolgpt-sqlite-backup-v1",
          backupID: selected.backupID,
          keyID: selected.keyID,
          bytes: selected.bytes,
          sha256: selected.sha256,
          ...overrides[kind],
        },
        body: stream ?? new Response(archiveBytes(selected.bytes)).body!,
      }
    },
  }
}

type ArchiveManifest = {
  version: number
  format: "mongolgpt-sqlite-backup-v1"
  backupID: string
  keyID: string
  bytes: number
  sha256: string
}

function checkpointFixture(): CloudCheckpoint.Checkpoint {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    inventory: {
      version: 1,
      database: { bytes: 97, sha256: "1".repeat(64), schemaSha256: "2".repeat(64) },
      projects: [],
      sessions: [],
      aggregates: [],
      eventIDs: [],
      tombstonesRecorded: true,
      tombstones: [],
      counts: { events: 0, tombstones: 0 },
    },
    sqlite: {
      backupID: "22222222-2222-4222-8222-222222222222",
      keyID: "key_checkpoint_rpc",
      bytes: 33,
      sha256: "3".repeat(64),
      plaintext: { bytes: 97, sha256: "1".repeat(64) },
    },
    files: {
      backupID: "33333333-3333-4333-8333-333333333333",
      keyID: "key_checkpoint_rpc",
      bytes: 21,
      sha256: "4".repeat(64),
      plaintext: { bytes: 12, sha256: "5".repeat(64) },
    },
  }
}

function archiveBytes(bytes: number) {
  return new Uint8Array(Array.from({ length: bytes }, (_value, index) => index % 251))
}

function request(path: string, body: unknown) {
  return new Request(`${url}${path}`, { method: "POST", headers: jsonContent(), body: JSON.stringify(body) })
}

function jsonContent() {
  return { "content-type": "application/json" }
}

function canonicalBase64(value: Uint8Array) {
  return Buffer.from(value).toString("base64")
}

async function expectInvalid(input: Request) {
  const calls = new Array<string>()
  const response = await createCheckpointHandler(
    {
      history: historyStore({ checkpoint: checkpointFixture(), calls }),
      backups: backupStore(checkpointFixture()),
      masterKeyJson,
    },
    scope,
  )(input)
  expect(response.status).toBe(400)
  expect(calls).toEqual([])
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(JSON.stringify(await response.json())).not.toContain("SQL")
}

async function bounded<T>(promise: Promise<T>) {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("operation hung")), 250)),
  ])
}
