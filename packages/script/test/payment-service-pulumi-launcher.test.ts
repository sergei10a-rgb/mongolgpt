import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("compiled payment launcher invokes only the pinned executable with narrowed targets and forwards failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-payment-launcher-"))
  const bin = join(directory, "bin")
  const suffix = process.platform === "win32" ? ".exe" : ""
  const native = join(bin, `pulumi${suffix}`)
  const launcher = join(directory, `launcher${suffix}`)
  const fixture = join(directory, "native.ts")
  const receipt = join(directory, "invoked.json")
  const script = resolve(import.meta.dir, "../../../script/pulumi-dev-payment.ts")
  const args = [
    "preview",
    "--stack",
    "organization/mongolgpt/dev",
    "--non-interactive",
    "--event-log",
    join(directory, "events.json"),
    "--config",
    "cloudflare:version=6.15.0",
    "--config",
    "random:version=4.19.2",
    "--target",
    "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$cloudflare:index/workersScript:WorkersScript::PaymentServiceScript",
    "--target",
    "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$pulumi-nodejs:dynamic:Resource::PaymentServiceUrl.sst.cloudflare.WorkerUrl",
    "--target-dependents",
  ]
  const env = {
    ...process.env,
    PULUMI_HOME: directory,
    CLOUDFLARE_ACCOUNT_ID: "cc97ad90bfaf8a1da5de612eef2658f5",
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: "cc97ad90bfaf8a1da5de612eef2658f5",
    MONGOLGPT_DOMAIN: "mgpt.mn",
    MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
    MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
    TEST_RECEIPT: receipt,
  }
  try {
    await mkdir(bin)
    await Bun.write(
      fixture,
      `
if (process.argv[2] === "version") console.log(process.env.TEST_VERSION ?? "v3.215.0")
else {
  if (process.env.TEST_WAIT === "true") {
    process.on("SIGTERM", async () => {
      await Bun.write(process.env.TEST_RECEIPT! + ".stopped", "stopped")
      process.exit(23)
    })
    setInterval(() => {}, 1000)
  }
  await Bun.write(process.env.TEST_RECEIPT!, JSON.stringify(process.argv.slice(2)))
  process.exitCode = Number(process.env.TEST_STATUS ?? 0)
}
`,
    )
    for (const [entry, output] of [
      [fixture, native],
      [script, launcher],
    ]) {
      const build = Bun.spawn([process.execPath, "build", entry, "--compile", "--outfile", output], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await new Response(build.stdout).text()
      const error = await new Response(build.stderr).text()
      expect(await build.exited, error).toBe(0)
    }
    for (const [invocation, status] of [
      [args, 0],
      [args, 7],
      [["up", "--yes", "-f", ...args.slice(1)], 0],
      [["up", "--yes", "-f", ...args.slice(1)], 7],
    ] as const) {
      const child = Bun.spawn([launcher, ...invocation], {
        env: { ...env, TEST_STATUS: String(status) },
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(status)
      expect(output + error).toBe("")
      expect(await Bun.file(receipt).json()).toEqual(invocation.filter((arg) => arg !== "--target-dependents"))
    }
    await rm(receipt)
    for (const [argv, overrides] of [
      [[...args, "--exclude", "private-resource"], {}],
      [args, { TEST_VERSION: "private-non-pinned-version" }],
      [args, { PULUMI_HOME: "private-relative-home" }],
      [args, { MONGOLGPT_PAYMENT_ENVIRONMENT: "production" }],
    ] as const) {
      const child = Bun.spawn([launcher, ...argv], {
        env: { ...env, ...overrides },
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      expect(await child.exited).toBe(1)
      expect(output).toBe("")
      expect(error.trim()).toBe("Dev payment Pulumi invocation is not approved")
      expect(await Bun.file(receipt).exists()).toBe(false)
    }
    if (process.platform !== "win32") {
      const child = Bun.spawn([launcher, ...args], {
        env: { ...env, TEST_WAIT: "true" },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const deadline = Date.now() + 5_000
        while (!(await Bun.file(receipt).exists()) && Date.now() < deadline) await Bun.sleep(10)
        expect(await Bun.file(receipt).exists()).toBe(true)
        child.kill("SIGTERM")
        expect(await child.exited).toBe(23)
        expect(await Bun.file(receipt + ".stopped").text()).toBe("stopped")
      } finally {
        child.kill("SIGKILL")
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)
