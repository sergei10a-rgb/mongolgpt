import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

test("current admin runtime verifies real JWT signatures in workerd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-admin-access-worker-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/admin-access-worker.ts", import.meta.url))],
      outdir: directory,
      naming: "admin-access.mjs",
      target: "browser",
      external: ["cloudflare:workers"],
      banner: "import process from 'node:process';",
    })
    if (!build.success) throw new Error(`Admin Access worker build failed: ${build.logs.join("\n")}`)
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the native admin Access test")
    const child = spawn(
      node,
      ["--experimental-strip-types", "test/admin-access-worker.integration.ts", join(directory, "admin-access.mjs")],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      let text = ""
      const timer = setTimeout(() => child.kill("SIGTERM"), 60000)
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          text = (text + chunk).slice(-8000)
        })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        resolve({ code, text })
      })
    })
    if (result.code !== 0) throw new Error(`Admin Access worker test failed\n${result.text}`)
    const receipt = result.text.split(/\r?\n/).find((line) => line.startsWith("ADMIN_ACCESS_WORKER_RESULT "))
    expect(receipt).toBeDefined()
    const report = JSON.parse(receipt!.slice("ADMIN_ACCESS_WORKER_RESULT ".length))
    expect(report.ok).toBe(true)
    expect(report.checks).toBe(40)
    console.log(`Admin Access worker: ${report.checks} checks passed`)
  } finally {
    const inside = relative(tmpdir(), directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Admin Access bundle escaped temp root")
    await rm(directory, { recursive: true, force: true })
  }
}, 70000)
