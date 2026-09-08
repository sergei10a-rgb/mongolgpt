import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import upstream from "../vendor/sandbox-control/upstream.json"
import { verifySandboxBuild } from "../script/build-sandbox"

async function fixture(run: (directory: string, receipt: Record<string, string>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-sdk-receipt-"))
  const sha256 = (value: string | ArrayBuffer) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
  const binary = "synthetic fixture for build receipt checks, not SDK acceptance"
  const root = await Bun.file(new URL("../../../package.json", import.meta.url)).json()
  const receipt = {
    revision: upstream.revision,
    version: upstream.version,
    bun: root.packageManager.replace(/^bun@/, ""),
    patchSha256: sha256(
      await Bun.file(new URL("../vendor/sandbox-control/control-auth.patch", import.meta.url)).arrayBuffer(),
    ),
    binarySha256: sha256(binary),
  }
  try {
    await Bun.write(join(directory, "sandbox"), binary)
    await Bun.write(join(directory, "sandbox-build.json"), JSON.stringify(receipt))
    await run(directory, receipt)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("authenticated Sandbox build receipt", () => {
  test("accepts matching current pin, patch and binary digest", async () => {
    await fixture(async (directory) => {
      await verifySandboxBuild(directory)
    })
  })

  test.each(["revision", "version", "bun", "patchSha256", "binarySha256"])("rejects stale %s", async (field) => {
    await fixture(async (directory, receipt) => {
      await Bun.write(join(directory, "sandbox-build.json"), JSON.stringify({ ...receipt, [field]: "stale" }))
      await expect(verifySandboxBuild(directory)).rejects.toThrow("stale or modified")
    })
  })

  test("rejects a changed binary and malformed receipt", async () => {
    await fixture(async (directory) => {
      await Bun.write(join(directory, "sandbox"), "modified binary")
      await expect(verifySandboxBuild(directory)).rejects.toThrow("stale or modified")
      await Bun.write(join(directory, "sandbox-build.json"), "null")
      await expect(verifySandboxBuild(directory)).rejects.toThrow("stale or modified")
    })
  })

  test("both deployment paths rebuild the patched SDK before deployment", async () => {
    for (const name of ["deploy.yml", "deploy-dev-runtime.yml"]) {
      const file = await Bun.file(new URL(`../../../.github/workflows/${name}`, import.meta.url)).text()
      expect(file.indexOf("bun packages/runtime/script/build-sandbox.ts")).toBeGreaterThan(0)
      expect(file.indexOf("bun packages/runtime/script/build-sandbox.ts")).toBeLessThan(
        file.indexOf("bun --cwd packages/runtime script/deploy.ts"),
      )
    }
    const deploy = await Bun.file(new URL("../script/deploy.ts", import.meta.url)).text()
    expect(deploy.indexOf("await verifySandboxBuild()")).toBeLessThan(deploy.indexOf("Bun.spawn("))
  })
})
