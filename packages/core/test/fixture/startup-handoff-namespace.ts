import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"
import { ProcessGroup } from "@mongolgpt/core/process-group"

if (process.argv[2] === "child") {
  assert.equal(process.getuid?.(), 10001)
  if (process.argv[3] === "reject") {
    await assert.rejects(StartupHandoff.accept("/tmp"), { code: "handoff_cgroup_binding" })
    console.log("WRONG_GROUP_REJECTED")
  } else {
    assert.equal(await StartupHandoff.accept("/tmp"), null)
    console.log("MAPPED_GROUP_ACCEPTED")
  }
} else {
  assert.equal(process.getuid?.(), 0)
  const parent = process.argv[2]
  const launcher = process.argv[3]
  assert.match(parent, /^\/sys\/fs\/cgroup\/mongolgpt-[0-9a-f-]{36}$/)
  if (process.argv[4] === "enter") {
    // Anchor the new namespace inside our owned cgroup, never a host sibling.
    await writeFile(`${parent}/cgroup.procs`, String(process.pid))
    execFileSync("/usr/bin/unshare", ["--cgroup", process.execPath, process.argv[1], parent, launcher, "nested"], {
      stdio: "inherit",
    })
    process.exit(0)
  }
  const subtree =
    process.argv[4] === "nested"
      ? await ProcessGroup.create({ launcher, uid: 10001, gid: 10001, root: parent })
      : undefined
  // Only this disposable process has a private mount namespace.
  let mounted = false
  try {
    execFileSync("/usr/bin/mount", ["--bind", subtree?.directory ?? parent, "/sys/fs/cgroup"])
    mounted = true
    const first = await ProcessGroup.create({ launcher, uid: 10001, gid: 10001 })
    try {
      const second = await ProcessGroup.create({ launcher, uid: 10001, gid: 10001 })
      try {
        const mount = (await readFile("/proc/self/mountinfo", "utf8"))
          .split("\n")
          .filter((line) => line.split(" ")[4] === "/sys/fs/cgroup")
        assert.ok(mount.some((line) => line.split(" ")[3] !== "/"))
        for (const reject of [false, true]) {
          const packet = await StartupHandoff.issue({ root: "/tmp", group: first.directory, checkpoint: null })
          try {
            const child = await (reject ? second : first).spawn({
              executable: process.execPath,
              args: [process.argv[1], "child", ...(reject ? ["reject"] : [])],
              cwd: "/tmp",
              env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", MONGOLGPT_RUNTIME_PREPARED_FD: "4" },
              startupFD: packet.fd,
            })
            let stdout = ""
            let stderr = ""
            child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()))
            child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()))
            const code = await new Promise<number | null>((resolve, reject) => {
              child.once("error", reject)
              child.once("close", resolve)
            })
            assert.equal(code, 0, stderr)
            assert.equal(stdout.trim(), reject ? "WRONG_GROUP_REJECTED" : "MAPPED_GROUP_ACCEPTED")
          } finally {
            await packet.close()
          }
        }
      } finally {
        await second.close()
      }
    } finally {
      await first.close()
    }
  } finally {
    if (mounted) execFileSync("/usr/bin/umount", ["/sys/fs/cgroup"])
    await subtree?.close()
  }
  console.log("NAMESPACED_HANDOFF_VERIFIED")
}
