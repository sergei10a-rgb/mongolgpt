import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const script = resolve(import.meta.dir, "../../../script/report-dev-payment-failure.ts")
const secret = "secret-token-private-value-owner@example.com-CLOUDFLARE_API_TOKEN"

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr, parsed: JSON.parse(stdout) as { status: string; sst: string } }
}

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "mongolgpt-payment-report-"))
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
  return root
}

test("reports only allowlisted status and target-not-found classification", async () => {
  const root = await fixture({
    receipt: JSON.stringify({ status: "native-failed", private: secret }),
    stdout: `Target not found: ${secret}`,
    stderr: `ignored ${secret}`,
  })
  try {
    const result = await run([join(root, "receipt"), join(root, "stdout"), join(root, "stderr")])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.parsed).toEqual({ status: "native-failed", sst: "target-not-found" })
    expect(result.stdout + result.stderr).not.toContain(secret)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("classifies SST target exclude flag conflict without leaking log content", async () => {
  const root = await fixture({
    receipt: JSON.stringify({ status: "arguments-approved" }),
    stdout: `flags in the group [target exclude] ${secret}`,
    stderr: "",
  })
  try {
    const result = await run([join(root, "receipt"), join(root, "stdout"), join(root, "stderr")])
    expect(result.parsed).toEqual({ status: "arguments-approved", sst: "scope-flag-conflict" })
    expect(result.stdout + result.stderr).not.toContain(secret)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unknown receipt status, malformed receipt, and empty receipt become unavailable", async () => {
  const root = await fixture({ stdout: "ordinary log", stderr: "" })
  try {
    for (const [name, receipt] of [
      ["unknown", JSON.stringify({ status: "not-allowlisted", private: secret })],
      ["malformed", `{"status":"native-failed","private":"${secret}"`],
      ["empty", ""],
    ]) {
      await writeFile(join(root, name), receipt)
      const result = await run([join(root, name), join(root, "stdout"), join(root, "stderr")])
      expect(result.parsed).toEqual({ status: "unavailable", sst: "unclassified" })
      expect(result.stdout + result.stderr).not.toContain(secret)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("missing, non-regular, oversized, and wrong argument count stay finite unreadable", async () => {
  const root = await fixture({
    receipt: JSON.stringify({ status: "started" }),
    stdout: "ordinary",
    stderr: "ordinary",
    oversizedReceipt: "x".repeat(1025),
    "oversized-log": "x".repeat(16 * 1024 * 1024 + 1),
  })
  try {
    await mkdir(join(root, "directory"))
    expect((await run([])).parsed).toEqual({ status: "unavailable", sst: "unreadable" })
    expect((await run([join(root, "receipt"), join(root, "missing"), join(root, "stderr")])).parsed).toEqual({
      status: "started",
      sst: "unreadable",
    })
    expect((await run([join(root, "receipt"), join(root, "directory"), join(root, "stderr")])).parsed).toEqual({
      status: "started",
      sst: "unreadable",
    })
    expect((await run([join(root, "oversizedReceipt"), join(root, "stdout"), join(root, "stderr")])).parsed).toEqual({
      status: "unavailable",
      sst: "unclassified",
    })
    expect((await run([join(root, "receipt"), join(root, "oversized-log"), join(root, "stderr")])).parsed).toEqual({
      status: "started",
      sst: "unreadable",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("oversized SST logs are unreadable and private data is never emitted", async () => {
  const root = await fixture({
    receipt: JSON.stringify({ status: "runtime-launch", private: secret }),
    stdout: "x".repeat(16 * 1024 * 1024 + 1),
    stderr: secret,
  })
  try {
    const result = await run([join(root, "receipt"), join(root, "stdout"), join(root, "stderr")])
    expect(result.parsed).toEqual({ status: "runtime-launch", sst: "unreadable" })
    expect(result.stdout + result.stderr).not.toContain(secret)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
