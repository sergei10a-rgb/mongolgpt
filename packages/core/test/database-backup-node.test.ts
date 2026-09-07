import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "./fixture/tmpdir"

test("runs the same encrypted backup/restore through the real Node SQLite adapter", async () => {
  await using temp = await tmpdir()
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for SQLite backup portability verification")
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./fixture/database-backup-node.ts", import.meta.url))],
    outdir: temp.path,
    naming: "backup.mjs",
    target: "node",
  })
  expect(build.success).toBe(true)
  const child = spawn(node, [join(temp.path, "backup.mjs"), temp.path], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000)
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-4000)
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })
  expect(output.code, output.stderr).toBe(0)
  expect(output.stdout).toContain("DATABASE_BACKUP_NODE_OK")
}, 40_000)
