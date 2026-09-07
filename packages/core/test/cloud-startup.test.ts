import { expect, test } from "bun:test"
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { tmpdir } from "./fixture/tmpdir"

test("accepts only a confirmed empty history for a pristine workspace", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(join(root, ".mongolgpt/data/mongolgpt/log"), { recursive: true })
  const calls: Request[] = []
  expect(
    await CloudStartup.bootstrap({
      root,
      request: async (request) => {
        calls.push(request)
        return Response.json({ checkpoint: null })
      },
    }),
  ).toBeNull()
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe("http://checkpoint.mongolgpt.internal/v1/bootstrap")
  expect(calls[0].method).toBe("POST")
  expect(calls[0].redirect).toBe("error")
  expect(await calls[0].json()).toEqual({})
  expect(await readdir(temp.path)).toEqual(["workspace"])
  expect(() => CloudStartup.baseline()).toThrow()
})

test("refuses existing files without requesting a checkpoint or modifying content", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(join(root, ".mongolgpt"), { recursive: true })
  const filename = join(root, ".mongolgpt/runtime.sqlite")
  await writeFile(filename, "uncheckpointed-data")
  let requested = false
  await expect(
    CloudStartup.bootstrap({
      root,
      request: async () => {
        requested = true
        return Response.json({ checkpoint: null })
      },
    }),
  ).rejects.toThrow("Cloud ажлын талбарыг")
  expect(requested).toBe(false)
  expect(await readFile(filename, "utf8")).toBe("uncheckpointed-data")
  expect(await readdir(temp.path)).toEqual(["workspace"])
})

test("refuses a root ancestor symlink without contacting the service", async () => {
  await using temp = await tmpdir()
  await mkdir(join(temp.path, "real/workspace"), { recursive: true })
  await symlink(join(temp.path, "real"), join(temp.path, "linked"), "junction")
  let requested = false
  await expect(
    CloudStartup.bootstrap({
      root: join(temp.path, "linked/workspace"),
      request: async () => {
        requested = true
        return Response.json({ checkpoint: null })
      },
    }),
  ).rejects.toThrow()
  expect(requested).toBe(false)
})

test("refuses an unknown empty directory in the application home", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(join(root, ".mongolgpt/user-project"), { recursive: true })
  await expect(
    CloudStartup.bootstrap({ root, request: async () => Response.json({ checkpoint: null }) }),
  ).rejects.toThrow()
  expect(await readdir(join(root, ".mongolgpt"))).toEqual(["user-project"])
})

for (const [name, response] of [
  ["HTML response", () => new Response("<html>not an API</html>", { headers: { "content-type": "text/html" } })],
  ["upstream failure", () => new Response("private details", { status: 503 })],
  ["unexpected credential on null baseline", () => Response.json({ checkpoint: null, keys: { sqlite: "secret" } })],
  [
    "oversized JSON",
    () => new Response(" ".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } }),
  ],
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
] as const) {
  test(`rejects ${name} with sanitized failure and no partial root`, async () => {
    await using temp = await tmpdir()
    const root = join(temp.path, "workspace")
    await mkdir(root)
    await expect(CloudStartup.bootstrap({ root, request: async () => response() })).rejects.toThrow(
      "Cloud ажлын талбарыг",
    )
    expect(await readdir(root)).toEqual([])
    expect(await readdir(temp.path)).toEqual(["workspace"])
  })
}

test("cancellation ends a stalled body even when stream cancellation never settles", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(root)
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  let cancelled = false
  const pending = CloudStartup.bootstrap({
    root,
    signal: controller.signal,
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
  const result = pending.then(
    () => ({ ok: true as const }),
    (error: Error) => ({ ok: false as const, error }),
  )
  await entered.promise
  controller.abort()
  const observed = await result
  expect(observed.ok).toBe(false)
  if (!observed.ok) expect(observed.error.message).toContain("Cloud ажлын талбарыг")
  expect(cancelled).toBe(true)
  expect(await readdir(temp.path)).toEqual(["workspace"])
})

test("refuses files introduced while fetching an empty baseline", async () => {
  await using temp = await tmpdir()
  const root = join(temp.path, "workspace")
  await mkdir(root)
  const filename = join(root, "new-file.txt")
  await expect(
    CloudStartup.bootstrap({
      root,
      request: async () => {
        await writeFile(filename, "keep this change")
        return Response.json({ checkpoint: null })
      },
    }),
  ).rejects.toThrow()
  expect(await readFile(filename, "utf8")).toBe("keep this change")
})
