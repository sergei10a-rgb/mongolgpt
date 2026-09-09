import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { fetchRuntime } from "../src/runtime-http"

test("native HTTP transport rejects control and arbitrary ports before invoking the DO", () => {
  const sandbox = {
    fetch: async () => {
      throw new Error("must not call")
    },
  }
  for (const port of [3000, 5173, 0, -1, Number.NaN]) {
    expect(() => fetchRuntime(sandbox, new Request("http://localhost/"), port)).toThrow("Invalid native runtime port")
  }
})

test("standard DO fetch admits the real readiness request that JSRPC cannot serialize", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  await mkdir(fileURLToPath(new URL("../.tmp", import.meta.url)), { recursive: true })
  const node = process.env.MONGOLGPT_TEST_NODE ?? Bun.which("node")
  if (!node) throw new Error("Node is required for the real workerd HTTP regression")
  const child = Bun.spawn([node, "--experimental-strip-types", "test/fixtures/runtime-http-runner.ts"], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 45_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, failure: exitCode === 0 ? "" : `${stdout}\n${stderr}` }).toEqual({ exitCode: 0, failure: "" })
    expect(stdout).toContain("RUNTIME_HTTP_RPC_PROOF_PASS")
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 60_000)
