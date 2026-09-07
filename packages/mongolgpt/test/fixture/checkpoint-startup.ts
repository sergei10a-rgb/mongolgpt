import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

const root = process.argv[2]
const proxy = new URL(process.argv[3])
const corrupt = process.argv[4] === "corrupt"
assert(root && path.isAbsolute(root))
assert.equal(proxy.hostname, "127.0.0.1")
const directory = path.join(root, "workspace")
await fs.mkdir(directory)
for (const name of ["data", "cache", "config", "state"])
  process.env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name)
Object.assign(process.env, {
  MONGOLGPT_TEST_HOME: root,
  MONGOLGPT_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
  MONGOLGPT_DB: path.join(directory, ".mongolgpt/runtime.sqlite"),
  MONGOLGPT_RUNTIME_MODE: "hosted",
  MONGOLGPT_CLOUD_HISTORY: "true",
  MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
  MONGOLGPT_DISABLE_DEFAULT_PLUGINS: "true",
  MONGOLGPT_DISABLE_MODELS_FETCH: "true",
  MONGOLGPT_DISABLE_AUTOUPDATE: "true",
  MONGOLGPT_PRINT_LOGS: "1",
  MONGOLGPT_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
  MONGOLGPT_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
})
delete process.env.MONGOLGPT_SERVER_PASSWORD
delete process.env.MONGOLGPT_SERVER_USERNAME
const original = globalThis.fetch
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
// An isolated child substitutes only the Cloudflare-injected internal transport;
// requests still reach the real D1/R2 handlers through the parent TCP server.
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (!["checkpoint.mongolgpt.internal", "history.mongolgpt.internal"].includes(url.hostname)) {
      assert.equal(url.hostname, "127.0.0.1", "fixture must not call external providers")
      return original(input, init)
    }
    if (url.hostname === "history.mongolgpt.internal" && url.pathname === "/v1/read") {
      entered.resolve()
      await release.promise
    }
    return original(new URL(`/${url.hostname.split(".")[0]}${url.pathname}`, proxy), {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
      redirect: "error",
    })
  },
  { preconnect: original.preconnect },
)

const { CloudStartup } = await import("@mongolgpt/core/database/cloud-startup")
const { Effect, Exit } = await import("effect")
assert.throws(() => CloudStartup.baseline())
if (corrupt) {
  await assert.rejects(CloudStartup.prepare({ root: directory }), /Cloud ажлын талбарыг/)
  assert.throws(() => CloudStartup.baseline())
  assert.deepEqual(await fs.readdir(directory), [])
  console.log("CHECKPOINT_CHILD_CORRUPT_PASS")
  globalThis.fetch = original
} else {
  const previous = process.cwd()
  console.log("checkpoint-startup: restoring")
  await CloudStartup.prepare({ root: directory })
  console.log("checkpoint-startup: restored")
  assert.equal(process.cwd(), directory)
  assert(CloudStartup.baseline())
  assert.equal(
    await fs.readFile(path.join(directory, "synthetic/transcript.txt"), "utf8"),
    "synthetic checkpoint file payload",
  )
  const { AppRuntime } = await import("../../src/effect/app-runtime")
  const { EventV2Bridge } = await import("../../src/event-v2-bridge")
  const { Database } = await import("@mongolgpt/core/database/database")
  const { PartTable } = await import("@mongolgpt/core/session/sql")
  const { Server } = await import("../../src/server/server")
  console.log("checkpoint-startup: modules loaded")
  const bridge = await AppRuntime.runPromise(EventV2Bridge.Service)
  console.log("checkpoint-startup: bridge loaded")
  let returned = false
  let server: Awaited<ReturnType<typeof Server.listen>> | undefined
  const pending = Server.listen({ hostname: "127.0.0.1", port: 0 }).then((value) => {
    returned = true
    server = value
    return value
  })
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("HTTP became ready before D1 replay")
      }),
    ])
    assert.equal(returned, false)
    assert(Exit.isFailure(await Effect.runPromiseExit(bridge.check)))
    release.resolve()
    const listener = await pending
    await Effect.runPromise(bridge.check)
    const response = await fetch(new URL("/api/session/ses_checkpoint", listener.url))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get("x-mongolgpt-runtime-history"), "checkpoint-v1")
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    const body = (await response.json()) as { data: { title: string } }
    assert.equal(body.data.title, "Checkpoint Session")
    const parts = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        return yield* database.db.select().from(PartTable).all().pipe(Effect.orDie)
      }),
    )
    assert.equal(parts.length, 1)
    assert.equal(Reflect.get(parts[0].data, "text"), "D1 delta after checkpoint")
    console.log("CHECKPOINT_CHILD_READY_PASS")
  } finally {
    release.resolve()
    await server?.stop(true)
    await AppRuntime.dispose()
    console.log("checkpoint-startup: runtime disposed")
    globalThis.fetch = original
    process.chdir(previous)
  }
}
// Match the real CLI entrypoint: native watcher threads can outlive disposal.
process.exit(0)
