import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { chmod, chown, mkdir, open, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises"
import type { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { Effect } from "effect"
import { ProcessGroup } from "@mongolgpt/core/process-group"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { WorkspaceCapture } from "@mongolgpt/core/database/workspace-capture"
import { WorkspaceRestore } from "@mongolgpt/core/database/workspace-restore"
import { RuntimeSupervisor } from "@mongolgpt/core/runtime-supervisor"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"
import { tmpdir } from "./fixture/tmpdir"
import { cloudFilesSeed } from "./fixture/cloud-files-seed"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

const launcher = process.env.MONGOLGPT_TEST_WORKSPACE_LAUNCHER
const policy = process.env.MONGOLGPT_TEST_WORKSPACE_POLICY
const startup = process.env.MONGOLGPT_TEST_STARTUP_CHILD
const isolated = process.platform === "linux" && process.getuid?.() === 0 && !!launcher && !!policy

test("process groups reject privileged tenant identities before creating anything", async () => {
  await expect(ProcessGroup.create({ launcher: "/not/a/launcher", uid: 0, gid: 0 })).rejects.toBeInstanceOf(
    ProcessGroup.IsolationError,
  )
})

test("process groups reject a non-cgroup root before starting anything", async () => {
  await expect(
    ProcessGroup.create({ launcher: "/not/a/launcher", uid: 10001, gid: 10001, root: "/tmp" }),
  ).rejects.toBeInstanceOf(ProcessGroup.IsolationError)
})

describe.skipIf(!isolated)("actual Linux hosted process group", () => {
  async function group() {
    return ProcessGroup.create({ launcher: launcher!, uid: 10001, gid: 10001 })
  }

  function command(code: string, cwd: string) {
    return { executable: process.execPath, args: ["-e", code], cwd, env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" } }
  }

  function startupCommand(root: string, reject = false) {
    if (!startup) throw new Error("Startup child fixture is required")
    return {
      executable: process.execPath,
      args: [startup, root, ...(reject ? ["reject"] : [])],
      cwd: root,
      env: {
        BUN_BE_BUN: "1",
        PATH: "/usr/bin:/bin",
        HOME: root,
        ...(process.env.MONGOLGPT_TEST_PTY_LIB ? { BUN_PTY_LIB: process.env.MONGOLGPT_TEST_PTY_LIB } : {}),
        MONGOLGPT_RUNTIME_MODE: "hosted",
        MONGOLGPT_CLOUD_HISTORY: "true",
        MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
        MONGOLGPT_RUNTIME_PREPARED_FD: "4",
        MONGOLGPT_DB: join(root, ".mongolgpt/runtime.sqlite"),
      },
    }
  }

  test("supervisor restores before non-root startup and hands off a read-only anonymous receipt", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const root = join(temp.path, "workspace")
    await mkdir(root)
    let bootstraps = 0
    const runtime = await RuntimeSupervisor.start({
      root,
      launcher: launcher!,
      ...startupCommand(root),
      request: async (request) => {
        expect(request.url).toBe("http://checkpoint.mongolgpt.internal/v1/bootstrap")
        bootstraps++
        return Response.json({ checkpoint: null })
      },
    })
    try {
      const result = await output(runtime.child)
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe("STARTUP_HANDOFF_READY")
      expect(bootstraps).toBe(1)
      expect(await readFile(join(root, "child-owned.txt"), "utf8")).toBe("restored then isolated")
    } finally {
      await runtime.group.close()
    }
  })

  test("startup rejects a valid receipt inherited by a different cgroup", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const root = join(temp.path, "workspace")
    await mkdir(root)
    await chown(root, 10001, 10001)
    const first = await group()
    const second = await group()
    try {
      const packet = await StartupHandoff.issue({ root, group: first.directory, checkpoint: null })
      try {
        const result = await output(await second.spawn({ ...startupCommand(root, true), startupFD: packet.fd }))
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe("STARTUP_HANDOFF_REJECTED")
        expect(await readdir(root)).toEqual([])
      } finally {
        await packet.close()
      }
    } finally {
      await first.close()
      await second.close()
    }
  })

  test("supervised file publication holds detached writers until receipt and kills them on unknown acknowledgement", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const seed = await cloudFilesSeed(temp.path)
    const root = join(temp.path, "publication-workspace")
    await mkdir(root)
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let failed = false
    let latest: CloudCheckpoint.FileRevision | undefined
    let captured = ""
    const cmd = startupCommand(root)
    const runtime = await RuntimeSupervisor.start({
      ...cmd,
      args: [startup!, root, "writer"],
      root,
      launcher: launcher!,
      request: async (request) => {
        const route = new URL(request.url).pathname
        if (route === "/v1/bootstrap")
          return Response.json({
            checkpoint: seed.checkpoint,
            ...(latest ? { filesRevision: latest } : {}),
            keys: { sqlite: seed.key.toString("base64"), files: seed.key.toString("base64") },
          })
        if (route === "/v1/archive") {
          const input = (await request.json()) as { kind: "sqlite" | "files" }
          const bytes = seed.bodies.get(seed.checkpoint[input.kind].backupID)!
          return new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
          })
        }
        expect(await readFile(join(runtime.group.directory, "cgroup.freeze"), "utf8")).toBe("1\n")
        if (route === "/v1/upload") {
          const bytes = Buffer.from(await request.arrayBuffer())
          const backupID = randomUUID()
          seed.bodies.set(backupID, bytes)
          captured = await readFile(join(root, "project/counter.txt"), "utf8")
          return Response.json({
            backupID,
            keyID: "synthetic",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          })
        }
        expect(route).toBe("/v1/publish-files")
        const input = (await request.json()) as {
          epoch: number
          writerID: string
          revision: CloudCheckpoint.FileRevision
        }
        expect(input.epoch).toBe(1)
        expect(input.writerID).toBe("writer_native")
        if (failed) throw new Error("Unknown final acknowledgement with private transport details")
        ready.resolve()
        await release.promise
        latest = input.revision
        return Response.json({ data: latest, digest: "a".repeat(64) })
      },
    })
    try {
      const counter = join(root, "project/counter.txt")
      await waitUntil(async () => Number(await readFile(counter, "utf8").catch(() => "0")) > 1)
      let acknowledged = false
      const publishing = runtime
        .publishFiles({ epoch: 1, writerID: "writer_native" }, AbortSignal.timeout(15_000))
        .then((value) => {
          acknowledged = true
          return value
        })
      await Promise.race([
        ready.promise,
        publishing.then(() => {
          throw new Error("Publication did not wait for its receipt")
        }),
      ])
      await setTimeout(100)
      expect(acknowledged).toBe(false)
      expect(await readFile(counter, "utf8")).toBe(captured)
      release.resolve()
      const receipt = await publishing
      expect(receipt.data).toEqual(latest!)
      await waitUntil(async () => (await readFile(counter, "utf8")) !== captured)
      const cipher = join(temp.path, "published.backup")
      await writeFile(cipher, seed.bodies.get(receipt.data.archive.backupID)!)
      const database = join(temp.path, "published.sqlite")
      const report = await Effect.runPromise(
        DatabaseBackup.restore({ source: cipher, destination: database, key: seed.key }),
      )
      const restored = join(temp.path, "published-files")
      await Effect.runPromise(
        WorkspaceRestore.materialize({ source: database, expected: report, destination: restored }),
      )
      expect(await readFile(join(restored, "project/counter.txt"), "utf8")).toBe(captured)
      failed = true
      await expect(runtime.publishFiles({ epoch: 1, writerID: "writer_native" })).rejects.toThrow("Cloud файлууд")
      expect(await readdir(runtime.group.directory).catch(() => null)).toBeNull()
      const final = await readFile(counter, "utf8")
      expect(final).toBe(captured)
      await setTimeout(100)
      expect(await readFile(counter, "utf8")).toBe(final)
    } finally {
      release.resolve()
      seed.key.fill(0)
      await runtime.group.close()
    }
  }, 30_000)

  test("startup cancellation removes its group before any tenant process runs", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const root = join(temp.path, "workspace")
    await mkdir(root)
    const before = new Set(await readdir("/sys/fs/cgroup"))
    const abort = new AbortController()
    const created: string[] = []
    await expect(
      RuntimeSupervisor.start({
        root,
        launcher: launcher!,
        ...startupCommand(root),
        signal: abort.signal,
        request: async () => {
          created.push(
            ...(await readdir("/sys/fs/cgroup")).filter((name) => name.startsWith("mongolgpt-") && !before.has(name)),
          )
          abort.abort(new Error("cancel startup"))
          return Response.json({ checkpoint: null })
        },
      }),
    ).rejects.toThrow()
    expect(created).toHaveLength(1)
    await expect(readdir(join("/sys/fs/cgroup", created[0]))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(root)).toEqual([])
  })

  for (const mode of ["publication", "terminal"] as const) {
    for (const failure of [false, true]) {
      test(`native child ${mode} acknowledgement waits for inherited supervisor channel, failure=${failure}`, async () => {
        await using temp = await tmpdir()
        await chmod(temp.path, 0o755)
        const seed = await cloudFilesSeed(temp.path)
        const root = join(temp.path, "controlled-workspace")
        await mkdir(root)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let captured = ""
        let archive: Buffer | undefined
        const runtime = await RuntimeSupervisor.start({
          ...startupCommand(root),
          args: [startup!, root, mode],
          root,
          launcher: launcher!,
          request: async (request) => {
            const route = new URL(request.url).pathname
            if (route === "/v1/bootstrap")
              return Response.json({
                checkpoint: seed.checkpoint,
                keys: { sqlite: seed.key.toString("base64"), files: seed.key.toString("base64") },
              })
            if (route === "/v1/archive") {
              const { kind } = (await request.json()) as { kind: "sqlite" | "files" }
              const bytes = seed.bodies.get(seed.checkpoint[kind].backupID)!
              return new Response(new Uint8Array(bytes), {
                headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
              })
            }
            expect(await readFile(join(runtime.group.directory, "cgroup.freeze"), "utf8")).toBe("1\n")
            if (route === "/v1/upload") {
              archive = Buffer.from(await request.arrayBuffer())
              captured = await readFile(join(root, "project/counter.txt"), "utf8")
              return Response.json({
                backupID: randomUUID(),
                keyID: "synthetic",
                bytes: archive.length,
                sha256: createHash("sha256").update(archive).digest("hex"),
              })
            }
            expect(route).toBe("/v1/publish-files")
            const input = (await request.json()) as {
              epoch: number
              writerID: string
              revision: CloudCheckpoint.FileRevision
            }
            expect(input.epoch).toBe(8)
            expect(input.writerID).toMatch(/^[0-9a-f-]{36}$/)
            expect({ epoch: input.epoch, writerID: input.writerID }).toEqual(
              JSON.parse(await readFile(join(root, "claimed-lease.json"), "utf8")),
            )
            entered.resolve()
            await release.promise
            if (failure) throw new Error("lost receipt")
            return Response.json({ data: input.revision, digest: "b".repeat(64) })
          },
        })
        const done = output(runtime.child)
        try {
          await Promise.race([
            entered.promise,
            done.then((result) => {
              throw new Error(`Child ended before publication: ${JSON.stringify(result)}`)
            }),
          ])
          expect(existsSync(join(root, "history-acknowledged.txt"))).toBe(false)
          await setTimeout(100)
          expect(await readFile(join(root, "project/counter.txt"), "utf8")).toBe(captured)
          release.resolve()
          if (failure) {
            await done
            await runtime.control.catch(() => {})
            expect(existsSync(join(root, "history-acknowledged.txt"))).toBe(false)
            expect(await readdir(runtime.group.directory).catch(() => null)).toBeNull()
            expect(await readFile(join(root, "project/counter.txt"), "utf8")).toBe(captured)
          } else {
            await waitUntil(async () => existsSync(join(root, "history-acknowledged.txt")))
            expect(await readFile(join(root, "history-acknowledged.txt"), "utf8")).toBe("durable tool")
            const source = join(temp.path, "controlled.backup")
            const database = join(temp.path, "controlled.sqlite")
            await writeFile(source, archive!)
            const report = await Effect.runPromise(
              DatabaseBackup.restore({ source, destination: database, key: seed.key }),
            )
            const destination = join(temp.path, "controlled-restore")
            await Effect.runPromise(WorkspaceRestore.materialize({ source: database, expected: report, destination }))
            expect(await readFile(join(destination, "project/tool-output.txt"), "utf8")).toBe("native tool result")
            expect(await readFile(join(destination, "project/counter.txt"), "utf8")).toBe(captured)
            expect(existsSync(join(destination, "history-acknowledged.txt"))).toBe(false)
          }
        } finally {
          release.resolve()
          await runtime.group.close()
          await runtime.control.catch(() => {})
          await done
          seed.key.fill(0)
        }
      }, 30_000)
    }
  }

  test("startup rejects a tenant-owned forged anonymous receipt", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const root = join(temp.path, "workspace")
    await mkdir(root)
    await chown(root, 10001, 10001)
    const controlled = await group()
    try {
      const filename = join(temp.path, "forged")
      await writeFile(
        filename,
        JSON.stringify({
          version: 1,
          root,
          group: controlled.directory.slice("/sys/fs/cgroup".length),
          checkpoint: null,
        }),
        { mode: 0o600 },
      )
      await chown(filename, 10001, 10001)
      const packet = await open(filename, "r")
      await unlink(filename)
      try {
        const result = await output(await controlled.spawn({ ...startupCommand(root, true), startupFD: packet.fd }))
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe("STARTUP_HANDOFF_REJECTED")
        expect(await readdir(root)).toEqual([])
      } finally {
        await packet.close()
      }
    } finally {
      await controlled.close()
    }
  })

  test("drops identities/capabilities and prevents group escape, root recovery and async kernel IO", async () => {
    const controlled = await group()
    try {
      const child = await controlled.spawn(
        command(
          `
        const fs = require("node:fs");
        const fields = Object.fromEntries(fs.readFileSync("/proc/self/status","utf8").split("\\n").filter(x=>x.includes(":")).map(x=>[x.slice(0,x.indexOf(":")),x.slice(x.indexOf(":")+1).trim()]));
        let escaped = false;
        try {fs.writeFileSync("/sys/fs/cgroup/cgroup.procs",String(process.pid));escaped=true;}catch{}
        console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),caps:fields.CapEff,bounding:fields.CapBnd,privileges:fields.NoNewPrivs,seccomp:fields.Seccomp,escaped,membership:fs.readFileSync("/proc/self/cgroup","utf8")}));
      `,
          "/tmp",
        ),
      )
      const result = await output(child)
      expect(result.code).toBe(0)
      const body = JSON.parse(result.stdout)
      expect(body).toMatchObject({
        uid: 10001,
        gid: 10001,
        caps: "0000000000000000",
        bounding: "0000000000000000",
        privileges: "1",
        seccomp: "2",
        escaped: false,
      })
      expect(body.groups).not.toContain(0)
      expect(body.membership).toContain(controlled.directory.slice("/sys/fs/cgroup".length))
      const probe = await output(await controlled.spawn({ executable: policy!, args: [], cwd: "/tmp", env: {} }))
      expect(probe.code).toBe(0)
      expect(JSON.parse(probe.stdout)).toEqual({ uid: 10001, ringDenied: true, aioDenied: true, rootDenied: true })
      await expect(
        controlled.spawn({ ...command("process.exit(0)", "/tmp"), env: { LD_PRELOAD: "/untrusted" } }),
      ).rejects.toBeInstanceOf(ProcessGroup.IsolationError)
    } finally {
      await controlled.close()
    }
  })

  test("freezes a detached orphan writer and restores the exact native checkpoint while later writes resume", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const source = join(temp.path, "workspace")
    await mkdir(source)
    await chown(source, 10001, 10001)
    const controlled = await group()
    const file = join(source, "counter.txt")
    const key = randomBytes(32)
    const archive = join(temp.path, "frozen.archive")
    try {
      const writer = `const fs=require("node:fs");let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(file)},String(++n)),5)`
      const leader = await output(
        await controlled.spawn(
          command(
            `
        const {spawn}=require("node:child_process");
        const child=spawn(process.execPath,["-e",${JSON.stringify(writer)}],{detached:true,stdio:"ignore",env:process.env});
        child.unref();console.log("started");
      `,
            source,
          ),
        ),
      )
      expect(leader.code).toBe(0)
      await waitUntil(async () => Number(await readFile(file, "utf8").catch(() => "0")) > 1)
      const captured = await controlled.quiesce(async () => {
        const before = await readFile(file, "utf8")
        await setTimeout(150)
        expect(await readFile(file, "utf8")).toBe(before)
        const result = await Effect.runPromise(WorkspaceCapture.create({ source, destination: archive, key }))
        expect(await readFile(file, "utf8")).toBe(before)
        return { result, before }
      })
      await waitUntil(async () => (await readFile(file, "utf8")) !== captured.before)
      const restored = join(temp.path, "restored.sqlite")
      await Effect.runPromise(DatabaseBackup.restore({ source: archive, destination: restored, key }))
      const destination = join(temp.path, "restored")
      await Effect.runPromise(
        WorkspaceRestore.materialize({ source: restored, expected: captured.result.report, destination }),
      )
      expect(await readFile(join(destination, "counter.txt"), "utf8")).toBe(captured.before)
      expect(captured.result.summary.files).toBe(1)
      await controlled.close()
      const final = await readFile(file, "utf8")
      await setTimeout(100)
      expect(await readFile(file, "utf8")).toBe(final)
      expect(await readdir(controlled.directory).catch(() => null)).toBeNull()
    } finally {
      key.fill(0)
      await controlled.close()
    }
  }, 30_000)

  test("keeps writers frozen until cancelled work settles, then thaws and serializes the next operation", async () => {
    const controlled = await group()
    try {
      const abort = new AbortController()
      let release!: () => void
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let next = false
      const first = controlled.quiesce(
        async (signal) => {
          started()
          await held
          signal!.throwIfAborted()
        },
        { signal: abort.signal },
      )
      const rejected = first.catch((error) => error)
      await ready
      abort.abort()
      const second = controlled.quiesce(async () => {
        next = true
      })
      await setTimeout(100)
      expect(next).toBe(false)
      expect(await readFile(join(controlled.directory, "cgroup.freeze"), "utf8")).toBe("1\n")
      release()
      expect(await rejected).toBe(abort.signal.reason)
      await second
      expect(next).toBe(true)
      expect(await readFile(join(controlled.directory, "cgroup.freeze"), "utf8")).toBe("0\n")
      await expect(
        controlled.quiesce(async () => {
          throw new Error("capture failed")
        }),
      ).rejects.toThrow("capture failed")
      expect(await readFile(join(controlled.directory, "cgroup.freeze"), "utf8")).toBe("0\n")
      await controlled.close()
      await expect(controlled.quiesce(async () => true)).rejects.toBeInstanceOf(ProcessGroup.IsolationError)
    } finally {
      await controlled.close()
    }
  })

  test("shutdown kills writers immediately while waiting for an active capture to settle", async () => {
    const controlled = await group()
    const child = await controlled.spawn(command("setInterval(()=>{},1000)", "/tmp"))
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    try {
      const operation = controlled.quiesce(async () => {
        entered()
        await held
        return "must not acknowledge"
      })
      const result = operation.catch((error) => error)
      await ready
      let closed = false
      const closing = controlled.close().then(() => {
        closed = true
      })
      await exited
      expect(closed).toBe(false)
      expect(await readFile(join(controlled.directory, "cgroup.events"), "utf8")).toContain("populated 0")
      await expect(controlled.spawn(command("process.exit(0)", "/tmp"))).rejects.toBeInstanceOf(
        ProcessGroup.IsolationError,
      )
      release()
      expect(await result).toBeInstanceOf(ProcessGroup.IsolationError)
      await closing
      expect(closed).toBe(true)
    } finally {
      release?.()
      await controlled.close()
    }
  })

  for (const failure of ["rejection", "cancellation"] as const) {
    test(`failed publication closes the frozen group without resuming writers on ${failure}`, async () => {
      await using temp = await tmpdir()
      await chmod(temp.path, 0o755)
      const root = join(temp.path, "workspace")
      await mkdir(root)
      await chown(root, 10001, 10001)
      const counter = join(root, "counter.txt")
      const controlled = await group()
      const abort = new AbortController()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let captured = ""
      try {
        await controlled.spawn(
          command(
            `const fs=require("node:fs");let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(counter)},String(++n)),1)`,
            root,
          ),
        )
        await waitUntil(async () => Number(await readFile(counter, "utf8").catch(() => "0")) > 1)
        const operation = controlled.quiesce(
          async () => {
            captured = await readFile(counter, "utf8")
            entered.resolve()
            await release.promise
            if (failure === "rejection") throw new Error("receipt unavailable")
            return "must not acknowledge"
          },
          { signal: abort.signal, closeOnError: true },
        )
        const rejected = operation.catch((error) => error)
        await entered.promise
        if (failure === "cancellation") abort.abort(new Error("publication cancelled"))
        await setTimeout(50)
        expect(await readFile(join(controlled.directory, "cgroup.freeze"), "utf8")).toBe("1\n")
        expect(await readFile(counter, "utf8")).toBe(captured)
        release.resolve()
        expect(await rejected).toBeInstanceOf(Error)
        expect(await readdir(controlled.directory).catch(() => null)).toBeNull()
        await expect(controlled.spawn(command("process.exit(0)", root))).rejects.toBeInstanceOf(
          ProcessGroup.IsolationError,
        )
        await setTimeout(50)
        expect(await readFile(counter, "utf8")).toBe(captured)
      } finally {
        release.resolve()
        await controlled.close()
      }
    })
  }

  test("shutdown settles a launcher that failed before receiving a PID", async () => {
    await using temp = await tmpdir()
    const filename = join(temp.path, "failed-launcher")
    await writeFile(filename, "#!/mongolgpt-missing-interpreter\n", { mode: 0o700 })
    const controlled = await ProcessGroup.create({ launcher: filename, uid: 10001, gid: 10001 })
    try {
      await expect(controlled.spawn(command("process.exit(0)", "/tmp"))).rejects.toBeInstanceOf(
        ProcessGroup.IsolationError,
      )
      await controlled.close()
      await expect(readdir(controlled.directory)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await controlled.close()
    }
  })

  test("shutdown kills detached descendants admitted after the first cgroup sweep", async () => {
    await using temp = await tmpdir()
    await chmod(temp.path, 0o755)
    const source = join(temp.path, "workspace")
    await mkdir(source)
    await chown(source, 10001, 10001)
    const filename = join(temp.path, "gated-launcher")
    const ready = join(temp.path, "launcher-ready")
    const release = join(temp.path, "release-launcher")
    const admitted = join(source, "writer-ready.json")
    const counter = join(source, "counter.txt")
    await writeFile(
      filename,
      `#!/bin/sh
printf ready > "$MONGOLGPT_TEST_LAUNCH_READY"
while [ ! -e "$MONGOLGPT_TEST_LAUNCH_RELEASE" ]; do sleep 0.01; done
exec "$MONGOLGPT_TEST_REAL_LAUNCHER" "$@"
`,
      { mode: 0o700 },
    )
    const controlled = await ProcessGroup.create({ launcher: filename, uid: 10001, gid: 10001 })
    const writer = `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(counter)}, "0");
      fs.writeFileSync(${JSON.stringify(admitted + ".tmp")}, JSON.stringify({uid:process.getuid(),group:fs.readFileSync("/proc/self/cgroup","utf8").trim()}));
      fs.renameSync(${JSON.stringify(admitted + ".tmp")}, ${JSON.stringify(admitted)});
      let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(counter)},String(++n)),5);
    `
    const cmd = command(
      `
      const {spawn} = require("node:child_process");
      spawn(process.execPath,["-e",${JSON.stringify(writer)}],{detached:true,stdio:"ignore",env:process.env}).unref();
      setInterval(()=>{},1000);
    `,
      source,
    )
    const child = await controlled.spawn({
      ...cmd,
      stdio: "ignore",
      env: {
        ...cmd.env,
        MONGOLGPT_TEST_LAUNCH_READY: ready,
        MONGOLGPT_TEST_LAUNCH_RELEASE: release,
        MONGOLGPT_TEST_REAL_LAUNCHER: launcher!,
      },
    })
    const kill = child.kill.bind(child)
    try {
      await waitUntil(async () => existsSync(ready))
      expect(await readFile(join(controlled.directory, "cgroup.events"), "utf8")).toContain("populated 0")
      // Gate only this handle's PID kill: the first real cgroup sweep has
      // completed, and the real native launcher must now admit a descendant.
      child.kill = (signal) => {
        writeFileSync(release, "go")
        const deadline = performance.now() + 5000
        const wait = new Int32Array(new SharedArrayBuffer(4))
        while (!existsSync(admitted)) {
          if (performance.now() >= deadline) throw new Error("Late descendant did not enter the cgroup")
          Atomics.wait(wait, 0, 0, 10)
        }
        return kill(signal)
      }
      await controlled.close()
      expect(JSON.parse(await readFile(admitted, "utf8"))).toEqual({
        uid: 10001,
        group: `0::${controlled.directory.slice("/sys/fs/cgroup".length)}`,
      })
      expect(child.signalCode).toBe("SIGKILL")
      await expect(readdir(controlled.directory)).rejects.toMatchObject({ code: "ENOENT" })
      const final = await readFile(counter, "utf8")
      await setTimeout(100)
      expect(await readFile(counter, "utf8")).toBe(final)
    } finally {
      child.kill = kill
      if (child.exitCode === null && child.signalCode === null) kill("SIGKILL")
      await waitUntil(async () => child.exitCode !== null || child.signalCode !== null)
      // Also reclaim the real descendant if the shutdown assertion fails.
      await writeFile(join(controlled.directory, "cgroup.kill"), "1").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      await waitUntil(async () => {
        const state = await readFile(join(controlled.directory, "cgroup.events"), "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            return null
          },
        )
        return state === null || state.includes("populated 0")
      })
      await rmdir(controlled.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }, 20_000)
})

async function output(child: ChildProcess) {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on("data", (data: Buffer) => stdout.push(data))
  child.stderr?.on("data", (data: Buffer) => stderr.push(data))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
}

async function waitUntil(predicate: () => Promise<boolean>) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error("Writer did not reach the expected state")
    await setTimeout(10)
  }
}
