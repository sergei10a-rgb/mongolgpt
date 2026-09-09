import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { deriveCheckpointControlToken } from "@mongolgpt/runtime-auth/control"
import { RuntimeCheckpointClient } from "../../core/src/runtime-checkpoint-client"
import { RuntimeBackupError, type RuntimeBackupManifest } from "../src/backup"
import { createCheckpointHandler, handleCheckpointOutbound } from "../src/checkpoint-rpc"
import { HistoryError, type HistoryLease, type HistoryScope } from "../src/history"

const scope = { accountID: "acc_publish_rpc", workspaceID: "wrk_publish_rpc" }
const origin = "http://checkpoint.mongolgpt.internal"
const keyID = "key_publish_v1"
const masterKeyJson = JSON.stringify({ [keyID]: Buffer.alloc(32, 7).toString("base64") })
const testMasterSecret = "checkpoint-publish-rpc-test-secret-32"
const maxBytes = 96 * 1024 * 1024
const digest = "a".repeat(64)
type Stores = Parameters<typeof createCheckpointHandler>[0]

describe("checkpoint upload RPC transport", () => {
  test("does not acknowledge an upload which finishes after retirement", async () => {
    const fixture = handler()
    let retired = false
    fixture.stores.history.assertActive = async () => {
      if (retired) throw new HistoryError("fenced")
    }
    const save = fixture.stores.backups!.save!
    fixture.stores.backups!.save = async (tenant, input) => {
      const receipt = await save(tenant, input)
      retired = true
      return receipt
    }
    const response = await fixture.handle(upload(stream([new Uint8Array([1])]), "1"))
    await expectFailure(response, 409, "conflict")
    expect(fixture.uploads).toHaveLength(1)
    // Bytes may already exist: draining and purging remain the coordinator's job.
    expect(fixture.publications).toHaveLength(0)
  })

  test("streams exact bytes under verified scope and returns only the receipt", async () => {
    const tenant = { ...scope }
    const fixture = handler({}, tenant)
    tenant.accountID = "untrusted_mutation"
    const response = await fixture.handle(
      upload(stream([new Uint8Array([1, 2]), new Uint8Array([3])]), "3", {
        "x-mongolgpt-account-id": "untrusted_header",
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect((await response.json()) as ReturnType<typeof receipt>).toEqual(receipt(3))
    expect(fixture.uploads).toEqual([{ scope, keyID, bytes: 3, chunks: 2 }])
    expect(fixture.publications).toEqual([])
  })

  test("accepts both transport size boundaries without buffering the complete upload", async () => {
    for (const length of [1, maxBytes]) {
      let remaining = length
      const chunk = new Uint8Array(1024 * 1024)
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (!remaining) return controller.close()
            const size = Math.min(chunk.byteLength, remaining)
            remaining -= size
            controller.enqueue(chunk.subarray(0, size))
          },
        },
        { highWaterMark: 0 },
      )
      const fixture = handler()
      const response = await fixture.handle(upload(body, String(length)))
      expect(response.status).toBe(200)
      expect((await response.json()) as ReturnType<typeof receipt>).toEqual(receipt(length))
      expect(fixture.uploads[0].bytes).toBe(length)
    }
  })

  test("rejects absent, noncanonical, zero, and oversized announced lengths before save", async () => {
    for (const length of [null, "0", "01", "+1", "-1", "1.0", "1e2", "1, 1", String(maxBytes + 1), "9".repeat(30)]) {
      const fixture = handler()
      await expectFailure(await fixture.handle(upload(stream([new Uint8Array([1])]), length)), 400, "invalid")
      expect(fixture.uploads).toEqual([])
    }
  })

  test("rejects missing and invalid key IDs and unconfigured versions before save", async () => {
    for (const key of [null, "", "../key", "_hidden", "x".repeat(257), "key_unknown", "constructor"]) {
      const request = upload(stream([new Uint8Array([1])]), "1")
      if (key === null) request.headers.delete("x-mongolgpt-backup-key-id")
      else request.headers.set("x-mongolgpt-backup-key-id", key)
      const fixture = handler()
      await expectFailure(await fixture.handle(request), 400, "invalid")
      expect(fixture.uploads).toEqual([])
    }
  })

  test("fails closed on unavailable save or invalid configured keys without exposing secrets", async () => {
    for (const options of [
      { backups: undefined },
      { backups: { open: unreadable } },
      { masterKeyJson: undefined },
      { masterKeyJson: "not-json-private-secret" },
      { masterKeyJson: JSON.stringify({ [keyID]: Buffer.alloc(31).toString("base64") }) },
    ]) {
      const fixture = handler(options)
      await expectFailure(await fixture.handle(upload(stream([new Uint8Array([1])]), "1")), 503, "unavailable")
      expect(fixture.uploads).toEqual([])
    }
  })

  test("rejects absent, short, oversized, and non-byte bodies without a receipt", async () => {
    for (const body of [
      null,
      stream([]),
      stream([new Uint8Array([1])]),
      stream([new Uint8Array([1, 2]), new Uint8Array([3])]),
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue("not bytes")
        },
      }) as unknown as ReadableStream<Uint8Array>,
    ]) {
      await expectFailure(await bounded(handler().handle(upload(body, "2"))), 400, "invalid")
    }
  })

  test("never awaits a stuck cancellation hook after rejecting oversize", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
      },
      cancel() {
        cancelled = true
        return new Promise(() => {})
      },
    })
    await expectFailure(await bounded(handler().handle(upload(body, "2"))), 400, "invalid")
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })

  test("times out a stuck read even after exactly the announced bytes arrive", async () => {
    for (const values of [[], [new Uint8Array([1, 2])]]) {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            values.forEach((value) => controller.enqueue(value))
          },
          pull() {
            return new Promise(() => {})
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        },
        { highWaterMark: 0 },
      )
      const fixture = handler({ uploadTimeoutMs: 20 })
      await expectFailure(await bounded(fixture.handle(upload(body, "2"))), 503, "unavailable")
      expect(cancelled).toBe(true)
      expect(body.locked).toBe(false)
    }
  })

  test("honors pre-abort and abort during a stuck read and cancellation", async () => {
    for (const preAborted of [true, false]) {
      const abort = new AbortController()
      const reading = Promise.withResolvers<void>()
      let cancelled = false
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve()
            return new Promise(() => {})
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        },
        { highWaterMark: 0 },
      )
      if (preAborted) abort.abort()
      const fixture = handler()
      const pending = fixture.handle(upload(body, "2", {}, abort.signal))
      if (!preAborted) {
        await bounded(reading.promise)
        abort.abort()
      }
      await expectFailure(await bounded(pending), 503, "unavailable")
      expect(cancelled).toBe(true)
      expect(body.locked).toBe(false)
      expect(fixture.uploads.length).toBe(preAborted ? 0 : 1)
    }
  })

  test("keeps one deadline across save backpressure and waits for save settlement", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const expired = Promise.withResolvers<unknown>()
    const fixture = handler({
      uploadTimeoutMs: 20,
      backups: {
        open: unreadable,
        async save(_scope, input) {
          const reader = input.body.getReader()
          void reader.closed.catch(expired.resolve)
          await reader.read()
          entered.resolve()
          await release.promise
          try {
            await reader.read()
            throw new Error("expired stream accepted")
          } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
          }
        },
      },
    })
    let settled = false
    const pending = fixture.handle(upload(stream([new Uint8Array([1]), new Uint8Array([2])]), "2")).then((result) => {
      settled = true
      return result
    })
    try {
      await bounded(entered.promise)
      await bounded(expired.promise)
      expect(settled).toBe(false)
    } finally {
      release.resolve()
    }
    await expectFailure(await bounded(pending), 503, "unavailable")
  })

  test("does not acknowledge mismatched receipts or leak additional manifest fields", async () => {
    for (const patch of [{ keyID: "other" }, { bytes: 7 }, { backupID: "bad" }, { sha256: "not-a-hash" }]) {
      const fixture = handler()
      const save = fixture.stores.backups!.save!
      fixture.stores.backups!.save = async (tenant, input) => ({ ...(await save(tenant, input)), ...patch })
      await expectFailure(await fixture.handle(upload(stream([new Uint8Array([1])]), "1")), 503, "unavailable")
    }
  })

  test("sanitizes save failures", async () => {
    for (const error of [
      new RuntimeBackupError("invalid"),
      new RuntimeBackupError("unavailable"),
      new Error("private-secret R2 SQL"),
    ]) {
      const fixture = handler({
        backups: {
          open: unreadable,
          save: async () => {
            throw error
          },
        },
      })
      await expectFailure(await fixture.handle(upload(stream([new Uint8Array([1])]), "1")), 503, "unavailable")
    }
  })
})

describe("checkpoint file publication RPC", () => {
  test("passes only verified scope and typed lease/checkpoint to the authenticating publisher", async () => {
    const tenant = { ...scope }
    const fixture = handler({}, tenant)
    tenant.workspaceID = "attacker"
    const input = checkpointPublication()
    const response = await fixture.handle(json("/v1/publish", input))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect((await response.json()) as { data: CloudCheckpoint.Checkpoint; digest: string }).toEqual({
      data: input.checkpoint,
      digest,
    })
    expect(fixture.checkpointPublications).toEqual([
      { lease: { ...scope, epoch: input.epoch, writerID: input.writerID }, checkpoint: input.checkpoint },
    ])
    expect(fixture.publications).toEqual([])
    expect(fixture.uploads).toEqual([])
  })

  test("passes only verified scope and typed lease/revision to the authenticating publisher", async () => {
    const tenant = { ...scope }
    const fixture = handler({}, tenant)
    tenant.workspaceID = "attacker"
    const input = publication()
    const response = await fixture.handle(json("/v1/publish-files", input))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect((await response.json()) as { data: CloudCheckpoint.FileRevision; digest: string }).toEqual({
      data: input.revision,
      digest,
    })
    expect(fixture.publications).toEqual([
      { lease: { ...scope, epoch: input.epoch, writerID: input.writerID }, revision: input.revision },
    ])
    expect(fixture.uploads).toEqual([])
  })

  test("rejects scope injection and invalid or inexact checkpoint publication envelopes before publishing", async () => {
    const input = checkpointPublication()
    for (const body of [
      { ...input, scope },
      { ...input, accountID: "attacker" },
      { ...input, workspaceID: "attacker" },
      { ...input, lease: { ...scope, epoch: 1, writerID: "attacker" } },
      { epoch: 1, writerID: "writer" },
      ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((epoch) => ({ ...input, epoch })),
      ...["", "../writer", "w".repeat(257)].map((writerID) => ({ ...input, writerID })),
      { ...input, checkpoint: { ...input.checkpoint, scope } },
      { ...input, checkpoint: { ...input.checkpoint, id: "invalid" } },
      { ...input, checkpoint: { ...input.checkpoint, sqlite: { ...input.checkpoint.sqlite, accountID: "attacker" } } },
      { ...input, checkpoint: { ...input.checkpoint, sqlite: { ...input.checkpoint.sqlite, keyID: "../key" } } },
      {
        ...input,
        checkpoint: {
          ...input.checkpoint,
          sqlite: { ...input.checkpoint.sqlite, plaintext: { bytes: 1, sha256: "c".repeat(64) } },
        },
      },
    ]) {
      const fixture = handler()
      await expectFailure(await fixture.handle(json("/v1/publish", body)), 400, "invalid")
      expect(fixture.checkpointPublications).toEqual([])
    }
  })

  test("allows only checkpoint publication to use the 1MiB JSON body bound", async () => {
    const input = checkpointPublication(largeCheckpoint())
    const encoded = JSON.stringify(input)
    expect(encoded.length).toBeGreaterThan(4096)
    const fixture = handler()
    const response = await fixture.handle(
      new Request(`${origin}/v1/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded,
      }),
    )
    expect(response.status).toBe(200)
    expect(fixture.checkpointPublications).toHaveLength(1)

    const files = handler()
    await expectFailure(
      await files.handle(
        new Request(`${origin}/v1/publish-files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoded,
        }),
      ),
      400,
      "invalid",
    )
    expect(files.publications).toEqual([])
  })

  test("rejects scope injection and invalid or inexact publication envelopes before publishing", async () => {
    const input = publication()
    for (const body of [
      { ...input, scope },
      { ...input, accountID: "attacker" },
      { ...input, workspaceID: "attacker" },
      { ...input, lease: { ...scope, epoch: 1, writerID: "attacker" } },
      { epoch: 1, writerID: "writer" },
      ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((epoch) => ({ ...input, epoch })),
      ...["", "../writer", "w".repeat(257)].map((writerID) => ({ ...input, writerID })),
      { ...input, revision: { ...input.revision, scope } },
      { ...input, revision: { ...input.revision, sequence: 0 } },
      { ...input, revision: { ...input.revision, sequence: 2, previousID: null } },
      { ...input, revision: { ...input.revision, id: "invalid" } },
      { ...input, revision: { ...input.revision, archive: { ...input.revision.archive, accountID: "attacker" } } },
      { ...input, revision: { ...input.revision, sqlite: { ...input.revision.archive } } },
      {
        ...input,
        revision: {
          ...input.revision,
          sqlite: { ...input.revision.archive, backupID: crypto.randomUUID(), keyID: "../key" },
        },
      },
      {
        ...input,
        revision: {
          ...input.revision,
          sqlite: { ...input.revision.archive, backupID: crypto.randomUUID(), accountID: "attacker" },
        },
      },
      {
        ...input,
        revision: { ...input.revision, archive: { ...input.revision.archive, plaintext: { bytes: 1, sha256: "bad" } } },
      },
      {
        ...input,
        revision: {
          ...input.revision,
          sqlite: {
            ...input.revision.archive,
            backupID: crypto.randomUUID(),
            plaintext: { bytes: 1, sha256: "bad" },
          },
        },
      },
    ]) {
      const fixture = handler()
      await expectFailure(await fixture.handle(json("/v1/publish-files", body)), 400, "invalid")
      expect(fixture.publications).toEqual([])
    }
  })

  test("rejects oversized checkpoint publication bodies before publishing", async () => {
    const fixture = handler()
    await expectFailure(
      await fixture.handle(
        new Request(`${origin}/v1/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...checkpointPublication(), padding: "x".repeat(1024 * 1024) }),
        }),
      ),
      400,
      "invalid",
    )
    expect(fixture.checkpointPublications).toEqual([])
  })

  test("keeps the 4096-byte JSON bound and rejects malformed encoding", async () => {
    for (const body of [" ".repeat(4097), "{", new Uint8Array([0xff])]) {
      const fixture = handler()
      const request = new Request(`${origin}/v1/publish-files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      await expectFailure(await fixture.handle(request), 400, "invalid")
      expect(fixture.publications).toEqual([])
    }
  })

  test("maps lease and publisher failures to the existing sanitized errors", async () => {
    for (const [error, status, code] of [
      [new HistoryError("fenced"), 409, "conflict"],
      [new HistoryError("conflict"), 409, "conflict"],
      [new HistoryError("invalid_input"), 400, "invalid"],
      [new HistoryError("unavailable"), 503, "unavailable"],
      [new RuntimeBackupError("invalid"), 503, "unavailable"],
      [new RuntimeBackupError("not_found"), 503, "unavailable"],
      [new Error("private-secret SQL/R2 details"), 503, "unavailable"],
    ] as const) {
      const files = handler({
        publisher: {
          publishFiles: async () => {
            throw error
          },
        },
      })
      await expectFailure(await files.handle(json("/v1/publish-files", publication())), status, code)
      const checkpoint = handler({
        publisher: {
          publish: async () => {
            throw error
          },
        },
      })
      await expectFailure(await checkpoint.handle(json("/v1/publish", checkpointPublication())), status, code)
    }
    await expectFailure(
      await handler({ publisher: undefined }).handle(json("/v1/publish-files", publication())),
      503,
      "unavailable",
    )
    await expectFailure(
      await handler({ publisher: undefined }).handle(json("/v1/publish", checkpointPublication())),
      503,
      "unavailable",
    )
  })

  test("does not publish a pre-aborted request", async () => {
    const abort = new AbortController()
    abort.abort()
    const fixture = handler()
    await expectFailure(
      await fixture.handle(json("/v1/publish-files", publication(), abort.signal)),
      503,
      "unavailable",
    )
    expect(fixture.publications).toEqual([])
  })

  test("does not publish a pre-aborted checkpoint request", async () => {
    const abort = new AbortController()
    abort.abort()
    const fixture = handler()
    await expectFailure(
      await fixture.handle(json("/v1/publish", checkpointPublication(), abort.signal)),
      503,
      "unavailable",
    )
    expect(fixture.checkpointPublications).toEqual([])
  })

  test("awaits publisher settlement after abort instead of returning an early acknowledgement", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const abort = new AbortController()
    const fixture = handler({
      publisher: {
        async publishFiles(_lease, revision) {
          entered.resolve()
          await release.promise
          return { data: revision, digest }
        },
      },
    })
    let settled = false
    const pending = fixture.handle(json("/v1/publish-files", publication(), abort.signal)).then((response) => {
      settled = true
      return response
    })
    try {
      await bounded(entered.promise)
      abort.abort()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
    } finally {
      release.resolve()
    }
    await expectFailure(await bounded(pending), 503, "unavailable")
  })

  test("awaits checkpoint publisher settlement after abort instead of returning an early acknowledgement", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const abort = new AbortController()
    const fixture = handler({
      publisher: {
        async publish(_lease, checkpoint) {
          entered.resolve()
          await release.promise
          return { data: checkpoint, digest }
        },
      },
    })
    let settled = false
    const pending = fixture.handle(json("/v1/publish", checkpointPublication(), abort.signal)).then((response) => {
      settled = true
      return response
    })
    try {
      await bounded(entered.promise)
      abort.abort()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
    } finally {
      release.resolve()
    }
    await expectFailure(await bounded(pending), 503, "unavailable")
  })

  test("outbound awaits the real publisher's archive lookup and does not bypass it with history CAS", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<null>()
    const abort = new AbortController()
    let sql = 0
    const db = admissionOnlyD1(() => sql++)
    const bucket = {
      get() {
        entered.resolve()
        return release.promise
      },
    } as unknown as R2Bucket
    let settled = false
    const pending = authenticatedOutbound(json("/v1/publish-files", publication(), abort.signal), {
      HISTORY: db,
      RUNTIME_BACKUPS: bucket,
      MONGOLGPT_RUNTIME_BACKUP_KEYS: masterKeyJson,
    }).then((response) => {
      settled = true
      return response
    })
    try {
      await bounded(entered.promise)
      abort.abort()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(sql).toBe(0)
    } finally {
      release.resolve(null)
    }
    await expectFailure(await bounded(pending), 503, "unavailable")
    expect(sql).toBe(0)
  })

  test("outbound checkpoint publish awaits the real archive lookup before history CAS", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<null>()
    const abort = new AbortController()
    let sql = 0
    const db = admissionOnlyD1(() => sql++)
    const bucket = {
      get() {
        entered.resolve()
        return release.promise
      },
    } as unknown as R2Bucket
    let settled = false
    const pending = authenticatedOutbound(json("/v1/publish", checkpointPublication(), abort.signal), {
      HISTORY: db,
      RUNTIME_BACKUPS: bucket,
      MONGOLGPT_RUNTIME_BACKUP_KEYS: masterKeyJson,
    }).then((response) => {
      settled = true
      return response
    })
    try {
      await bounded(entered.promise)
      abort.abort()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(sql).toBe(0)
    } finally {
      release.resolve(null)
    }
    await expectFailure(await bounded(pending), 503, "unavailable")
    expect(sql).toBe(0)
  })
})

test("write endpoints reject methods, content types, noncanonical paths and queries before stores", async () => {
  for (const request of [
    new Request(`${origin}/v1/upload`, { method: "GET" }),
    upload(stream([new Uint8Array([1])]), "1", { "content-type": "application/json" }),
    new Request(`${origin}/v1/publish-files`, { method: "POST", body: "{}" }),
    ...[
      "/v1/upload?x=1",
      "/v1/upload?",
      "/v1/upload#",
      "/v1/upload/",
      "/v1/%75pload",
      "/v1/publish-files?scope=other",
      "/v1/publish/",
      "/v1/publish-files/",
    ].map((path) => json(path, publication())),
    new Request("http://elsewhere.invalid/v1/upload", { method: "POST", body: "x" }),
  ]) {
    const fixture = handler()
    await expectFailure(await fixture.handle(request), 400, "invalid")
    expect(fixture.uploads).toEqual([])
    expect(fixture.publications).toEqual([])
  }
})

function admissionOnlyD1(unexpected: () => void) {
  const statement = {
    bind: (...args: unknown[]) => {
      expect(args).toEqual([scope.accountID])
      return statement
    },
  }
  return {
    prepare(query: string) {
      if (query === "SELECT account_id FROM runtime_history_retirement WHERE account_id = ?") return statement
      unexpected()
      throw new Error("unexpected CAS")
    },
    async batch(statements: unknown[]) {
      expect(statements).toEqual([statement])
      return [{ success: true, results: [] }]
    },
  } as unknown as D1Database
}

function handler(overrides: Partial<Stores> = {}, tenant = scope) {
  // These stubs test transport delegation only, not AES, R2 durability, or D1 CAS.
  const uploads: { scope: HistoryScope; keyID: string; bytes: number; chunks: number }[] = []
  const publications: { lease: HistoryLease; revision: CloudCheckpoint.FileRevision }[] = []
  const checkpointPublications: { lease: HistoryLease; checkpoint: CloudCheckpoint.Checkpoint }[] = []
  const stores: Stores = {
    history: {
      assertActive: async () => {},
      checkpoint: unreadable,
      epoch: unreadable,
      claim: unreadable,
      fileRevision: unreadable,
    },
    masterKeyJson,
    backups: {
      open: unreadable,
      async save(tenant, input) {
        const call = { scope: { ...tenant }, keyID: input.keyID, bytes: 0, chunks: 0 }
        uploads.push(call)
        const reader = input.body.getReader()
        try {
          for (;;) {
            const item = await reader.read()
            if (item.done) break
            call.bytes += item.value.byteLength
            call.chunks++
          }
          return manifest(call.bytes)
        } catch {
          throw new RuntimeBackupError("unavailable")
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      },
    },
    publisher: {
      async publish(lease, checkpoint) {
        checkpointPublications.push({ lease, checkpoint })
        return { data: checkpoint, digest }
      },
      async publishFiles(lease, revision) {
        publications.push({ lease, revision })
        return { data: revision, digest }
      },
    },
    ...overrides,
  }
  return { stores, handle: createCheckpointHandler(stores, tenant), uploads, publications, checkpointPublications }
}

async function authenticatedOutbound(
  request: Request,
  env: Parameters<typeof handleCheckpointOutbound>[1],
  tenant = scope,
) {
  return RuntimeCheckpointClient.create(await deriveCheckpointControlToken(testMasterSecret, tenant), (input) =>
    handleCheckpointOutbound(input, { ...env, MONGOLGPT_RUNTIME_SECRET: testMasterSecret }, { params: tenant }),
  )(request)
}

async function unreadable(): Promise<never> {
  throw new Error("unexpected read-only store call")
}

function receipt(bytes: number) {
  return { backupID: "11111111-1111-4111-8111-111111111111", keyID, bytes, sha256: "b".repeat(64) }
}

function manifest(bytes: number): RuntimeBackupManifest {
  return {
    ...receipt(bytes),
    ...scope,
    version: 1,
    format: "mongolgpt-sqlite-backup-v1",
    chunks: [{ bytes, sha256: digest }],
  }
}

function publication() {
  return {
    epoch: 3,
    writerID: "writer_publish_rpc",
    revision: {
      id: "22222222-2222-4222-8222-222222222222",
      checkpointID: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      previousID: null,
      archive: { ...receipt(64), plaintext: { bytes: 16, sha256: "c".repeat(64) } },
    } satisfies CloudCheckpoint.FileRevision,
  }
}

function checkpointPublication(input = checkpoint()) {
  return {
    epoch: 3,
    writerID: "writer_publish_rpc",
    checkpoint: input,
  }
}

function checkpoint(): CloudCheckpoint.Checkpoint {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    inventory: {
      version: 1,
      database: { bytes: 16, sha256: "c".repeat(64), schemaSha256: "d".repeat(64) },
      projects: [],
      sessions: [],
      aggregates: [],
      eventIDs: [],
      tombstonesRecorded: true,
      tombstones: [],
      counts: { events: 0, tombstones: 0 },
    },
    sqlite: {
      ...receiptFor("55555555-5555-4555-8555-555555555555"),
      plaintext: { bytes: 16, sha256: "c".repeat(64) },
    },
    files: {
      ...receiptFor("66666666-6666-4666-8666-666666666666"),
      plaintext: { bytes: 8, sha256: "e".repeat(64) },
    },
  }
}

function largeCheckpoint(): CloudCheckpoint.Checkpoint {
  const input = checkpoint()
  return {
    ...input,
    inventory: {
      ...input.inventory,
      projects: Array.from({ length: 180 }, (_value, index) => ({
        id: `project_${String(index).padStart(3, "0")}`,
        journaled: false,
      })),
    },
  }
}

function receiptFor(backupID: string) {
  return { backupID, keyID, bytes: 64, sha256: "b".repeat(64) }
}

function stream(values: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      values.forEach((value) => controller.enqueue(value))
      controller.close()
    },
  })
}

function upload(
  body: ReadableStream<Uint8Array> | null,
  length: string | null,
  extra: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request(`${origin}/v1/upload`, {
    method: "POST",
    signal,
    body,
    headers: {
      "content-type": "application/octet-stream",
      "x-mongolgpt-backup-key-id": keyID,
      ...(length === null ? {} : { "content-length": length }),
      ...extra,
    },
  })
}

function json(path: string, body: unknown, signal?: AbortSignal) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = await response.json()
  expect(body).toMatchObject({ error: { code } })
  expect(JSON.stringify(body)).not.toContain("private-secret")
  expect(JSON.stringify(body)).not.toContain(Buffer.alloc(32, 7).toString("base64"))
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("RPC did not settle")), 1000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
