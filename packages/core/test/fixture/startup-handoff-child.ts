import assert from "node:assert/strict"
import { fstatSync, writeSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"

const root = process.argv[2]
const reject = process.argv[3] === "reject"
const publication = process.argv[3] === "publication"
const terminal = process.argv[3] === "terminal"
const writer = process.argv[3] === "writer" || publication || terminal
assert.equal(process.getuid!(), 10001)
if (reject) {
  await assert.rejects(CloudStartup.prepare({ root }))
  assert.throws(() => CloudStartup.baseline())
  console.log("STARTUP_HANDOFF_REJECTED")
} else {
  assert.equal(fstatSync(4).uid, 0)
  assert.equal(fstatSync(4).nlink, 0)
  assert.throws(() => writeSync(4, Buffer.from("tampered")))
  await CloudStartup.prepare({ root })
  assert.equal(CloudStartup.supervised(), true)
  assert.equal(process.env.MONGOLGPT_RUNTIME_PREPARED_FD, undefined)
  if (writer) assert.ok(CloudStartup.baseline())
  else assert.equal(CloudStartup.baseline(), undefined)
  await writeFile(join(root, "child-owned.txt"), "restored then isolated")
  await CloudStartup.prepare({ root })
  assert.equal(CloudStartup.supervised(), true)
  console.log("STARTUP_HANDOFF_READY")
  if (writer) {
    const { spawn } = await import("node:child_process")
    spawn(
      process.execPath,
      [
        "-e",
        `
      const fs=require("node:fs");let count=0;
      setInterval(()=>fs.writeFileSync(${JSON.stringify(join(root, "project/counter.txt"))},String(++count)),5);
    `,
      ],
      { env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" }, detached: true, stdio: "ignore" },
    ).unref()
    if (publication || terminal) {
      const { Effect, Layer } = await import("effect")
      const { Event } = await import("@mongolgpt/schema/event")
      const { CloudWorkspace } = await import("@mongolgpt/core/database/cloud-workspace")
      const { createCloudHistory } = await import("@mongolgpt/core/event/cloud-history")
      const workspace = CloudWorkspace.connect()
      const cloud = createCloudHistory({
        checkpointID: CloudStartup.baseline()!.id,
        workspace: {
          async register(lease, signal) {
            try {
              await workspace.register(lease, signal)
            } catch (error) {
              console.error("CONTROL_REGISTER_FAILURE", error)
              throw error
            }
          },
          publish: workspace.publish,
        },
        request: async (request) => {
          if (request.url.endsWith("/epoch")) return Response.json({ epoch: 7 })
          if (request.url.endsWith("/claim")) {
            const { writerID } = (await request.json()) as { writerID: string }
            await writeFile(join(root, "claimed-lease.json"), JSON.stringify({ epoch: 8, writerID }))
            return Response.json({ epoch: 8, writerID })
          }
          assert.ok(request.url.endsWith("/append"))
          const body = (await request.json()) as { event: { type: string } }
          assert.equal(body.event.type, "session.next.tool.success.1")
          await writeFile(join(root, "history-acknowledged.txt"), "durable tool")
          return Response.json({ cursor: 1 })
        },
      })
      await Effect.runPromise(cloud.initialize)
      const { setTimeout } = await import("node:timers/promises")
      const deadline = performance.now() + 5000
      while (Number(await readFile(join(root, "project/counter.txt"), "utf8").catch(() => "0")) < 2) {
        assert.ok(performance.now() < deadline)
        await setTimeout(10)
      }
      if (terminal) {
        const { Pty } = await import("@mongolgpt/core/pty")
        const { Config } = await import("@mongolgpt/core/config")
        const { EventV2 } = await import("@mongolgpt/core/event")
        const { Location } = await import("@mongolgpt/core/location")
        const { AbsolutePath } = await import("@mongolgpt/core/schema")
        const { Project } = await import("@mongolgpt/core/project")
        const { writeFileSync } = await import("node:fs")
        await Effect.runPromise(
          Effect.gen(function* () {
            const pty = yield* Pty.Service
            const info = yield* pty.create({
              command: "/bin/sh",
              args: [
                "-c",
                "stty -echo; printf ready > pty-ready; read value; printf 'native tool result' > project/tool-output.txt; printf MGPT_TERMINAL; sleep 60",
              ],
              cwd: root,
            })
            let output = ""
            const attachment = yield* pty.attach(info.id, {
              onData(chunk) {
                output += chunk
                if (output.includes("MGPT_TERMINAL"))
                  writeFileSync(join(root, "history-acknowledged.txt"), "durable tool")
              },
              onEnd() {},
            })
            attachment.activate()
            const readyDeadline = performance.now() + 5000
            while (!(yield* Effect.promise(() => Bun.file(join(root, "pty-ready")).exists()))) {
              assert.ok(performance.now() < readyDeadline)
              yield* Effect.sleep("10 millis")
            }
            yield* pty.write(info.id, "start\n")
            yield* Effect.never
          }).pipe(
            Effect.provide(
              Pty.layer.pipe(
                Layer.provide(Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })),
                // This case exercises native PTY -> inherited channel -> root files.
                // CloudHistory's actual lease was already claimed and registered above.
                Layer.provide(
                  Layer.mock(EventV2.Service)({
                    publish: (definition, data) =>
                      Effect.succeed({ id: Event.ID.make("evt_pty_fixture"), type: definition.type, data }),
                  }),
                ),
                Layer.provide(
                  Layer.succeed(Location.Service, {
                    directory: AbsolutePath.make(root),
                    project: { id: Project.ID.global, directory: AbsolutePath.make(root) },
                  }),
                ),
              ),
            ),
            Effect.scoped,
          ),
        )
      }
      await writeFile(join(root, "project/tool-output.txt"), "native tool result")
      await Effect.runPromise(
        cloud.append({
          id: Event.ID.make("evt_native_tool"),
          aggregateID: "ses_native_tool",
          seq: 0,
          type: "session.next.tool.success.1",
          data: {},
        }),
      )
      console.log("CONTROL_PUBLICATION_READY")
    }
    setInterval(() => {}, 1000)
  }
}
