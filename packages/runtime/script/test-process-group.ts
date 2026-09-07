import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// This is an explicit, disposable root/cgroup integration test, not a unit-test
// fallback. A missing freezer, compiler or security filter must fail the gate.
if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Linux root integration runner required")
const root = fileURLToPath(new URL("../", import.meta.url))
const directory = await mkdtemp(join(tmpdir(), "mongolgpt-isolation-test-"))
try {
  await chmod(directory, 0o755)
  for (const [source, binary] of [
    ["container/workspace-launcher.c", "launcher"],
    ["test/fixtures/workspace-policy.c", "policy"],
  ]) {
    const compiler = Bun.spawn(
      ["cc", "-Os", "-s", "-Wall", "-Wextra", "-Werror", "-static", join(root, source), "-o", join(directory, binary)],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    if ((await compiler.exited) !== 0) throw new Error("Workspace isolation fixture compilation failed")
  }
  const bundle = await Bun.build({
    entrypoints: [join(root, "../core/test/process-group.test.ts")],
    target: "bun",
    external: ["bun:test"],
    outdir: directory,
    naming: "process-group.test.js",
  })
  if (!bundle.success) throw new Error("Workspace isolation integration build failed")
  const startup = await Bun.build({
    entrypoints: [join(root, "../core/test/fixture/startup-handoff-child.ts")],
    target: "bun",
    outdir: directory,
    naming: "startup-child.js",
  })
  if (!startup.success) throw new Error("Workspace startup child build failed")
  const child = Bun.spawn([process.execPath, "test", join(directory, "process-group.test.js")], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      BUN_BE_BUN: "1",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_STATE_HOME: join(directory, "state"),
      MONGOLGPT_TEST_WORKSPACE_LAUNCHER: join(directory, "launcher"),
      MONGOLGPT_TEST_WORKSPACE_POLICY: join(directory, "policy"),
      MONGOLGPT_TEST_STARTUP_CHILD: join(directory, "startup-child.js"),
    },
  })
  process.exitCode = await child.exited
} finally {
  await rm(directory, { recursive: true, force: true })
}
