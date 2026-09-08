import { expect, test } from "bun:test"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CloudFiles } from "@mongolgpt/core/database/cloud-files"
import { tmpdir } from "./fixture/tmpdir"
import { cloudFilesSeed } from "./fixture/cloud-files-seed"

const lease = { epoch: 1, writerID: "writer_publication_test" }
const checkpointID = "11111111-1111-4111-8111-111111111111"

for (const [name, response] of [
  ["missing baseline", () => Response.json({ checkpoint: null })],
  ["HTML", () => new Response("private HTML error", { headers: { "content-type": "text/html" } })],
  ["upstream error", () => new Response("private upstream error", { status: 503 })],
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  [
    "oversized bootstrap",
    () => new Response(" ".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ],
] as const) {
  test(`file publication rejects ${name} before capturing or uploading`, async () => {
    await using temp = await tmpdir()
    await writeFile(join(temp.path, "unchanged.txt"), "original")
    const calls: string[] = []
    await expect(
      CloudFiles.publish({
        root: temp.path,
        checkpointID,
        lease,
        signal: new AbortController().signal,
        request: async (request) => {
          calls.push(request.url)
          return response()
        },
      }),
    ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
    expect(calls).toEqual(["http://checkpoint.mongolgpt.internal/v1/bootstrap"])
    expect(await readdir(temp.path)).toEqual(["unchanged.txt"])
    expect(await readFile(join(temp.path, "unchanged.txt"), "utf8")).toBe("original")
  })
}

test("file publication rejects caller scope and pre-cancelled work without network activity", async () => {
  await using temp = await tmpdir()
  let called = false
  const request = async () => {
    called = true
    return Response.json({ checkpoint: null })
  }
  await expect(
    CloudFiles.publish({
      root: temp.path,
      checkpointID,
      lease: { ...lease, accountID: "forged" } as CloudFiles.Lease,
      signal: new AbortController().signal,
      request,
    }),
  ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
  await expect(
    CloudFiles.publish({
      root: temp.path,
      checkpointID,
      lease,
      signal: AbortSignal.abort(),
      request,
    }),
  ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
  expect(called).toBe(false)
})

test("file publication cancels stalled JSON without awaiting a stuck stream cancellation", async () => {
  await using temp = await tmpdir()
  const abort = new AbortController()
  const entered = Promise.withResolvers<void>()
  let cancelled = false
  const pending = CloudFiles.publish({
    root: temp.path,
    checkpointID,
    lease,
    signal: abort.signal,
    request: async () =>
      new Response(
        new ReadableStream({
          pull() {
            entered.resolve()
            return new Promise(() => {})
          },
          cancel() {
            cancelled = true
            return new Promise(() => {})
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  })
  const rejected = pending.catch((error) => error)
  await entered.promise
  abort.abort()
  expect(await rejected).toBeInstanceOf(CloudFiles.PublicationError)
  expect(cancelled).toBe(true)
  expect(await readdir(temp.path)).toEqual([])
})

test("file publication rejects a different baseline or malformed derived key before upload", async () => {
  await using temp = await tmpdir()
  const seed = await cloudFilesSeed(temp.path)
  const before = (await readdir(temp.path)).sort()
  try {
    for (const [id, key] of [
      [checkpointID, seed.key.toString("base64")],
      [seed.checkpoint.id, "not-a-canonical-key"],
    ]) {
      let calls = 0
      await expect(
        CloudFiles.publish({
          root: seed.source,
          checkpointID: id,
          lease,
          signal: new AbortController().signal,
          request: async () => {
            calls++
            return Response.json({ checkpoint: seed.checkpoint, keys: { sqlite: key, files: key } })
          },
        }),
      ).rejects.toBeInstanceOf(CloudFiles.PublicationError)
      expect(calls).toBe(1)
    }
    expect((await readdir(temp.path)).sort()).toEqual(before)
  } finally {
    seed.key.fill(0)
  }
})
