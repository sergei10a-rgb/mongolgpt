import { describe, expect, test } from "bun:test"
import { chmod, chown, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import type { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { ProcessGroup } from "@mongolgpt/core/process-group"
import { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { WorkspaceCapture } from "@mongolgpt/core/database/workspace-capture"
import { WorkspaceRestore } from "@mongolgpt/core/database/workspace-restore"
import { tmpdir } from "./fixture/tmpdir"

const launcher = process.env.MONGOLGPT_TEST_WORKSPACE_LAUNCHER
const policy = process.env.MONGOLGPT_TEST_WORKSPACE_POLICY
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
