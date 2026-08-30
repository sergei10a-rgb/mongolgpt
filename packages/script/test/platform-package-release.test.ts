import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const license = readFileSync(resolve(root, "LICENSE"), "utf8").replaceAll("\r\n", "\n")

const packages = [
  { name: "@mongolgpt/sdk", directory: "packages/sdk/js", docs: "https://docs.mgpt.mn/docs/sdk/" },
  { name: "@mongolgpt/plugin", directory: "packages/plugin", docs: "https://docs.mgpt.mn/docs/plugins/" },
  { name: "@mongolgpt/ui", directory: "packages/ui", docs: "https://docs.mgpt.mn/" },
] as const

describe("public platform npm package contract", () => {
  for (const item of packages) {
    test(`${item.name} has public MongolGPT metadata and legal files`, () => {
      const directory = resolve(root, item.directory)
      const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
        name?: string
        private?: boolean
        description?: string
        repository?: { type?: string; url?: string; directory?: string }
        homepage?: string
        bugs?: { url?: string }
        publishConfig?: { access?: string }
        files?: string[]
      }

      expect(manifest.name).toBe(item.name)
      expect(manifest.private).not.toBe(true)
      expect(manifest.description).toContain("MongolGPT")
      expect(manifest.repository).toEqual({
        type: "git",
        url: "git+https://github.com/sergei10a-rgb/mongolgpt.git",
        directory: item.directory,
      })
      expect(manifest.homepage).toBe(item.docs)
      expect(manifest.bugs?.url).toBe("https://github.com/sergei10a-rgb/mongolgpt/issues")
      expect(manifest.publishConfig?.access).toBe("public")
      expect(manifest.files).toContain("README.md")
      expect(manifest.files).toContain("LICENSE")
      expect(readFileSync(resolve(directory, "README.md"), "utf8")).toContain(`npm install ${item.name}`)
      expect(readFileSync(resolve(directory, "LICENSE"), "utf8").replaceAll("\r\n", "\n")).toBe(license)
    })
  }

  test("publish scripts use immutable release versions and safe dry runs", () => {
    for (const script of [
      "packages/sdk/js/script/publish.ts",
      "packages/plugin/script/publish.ts",
      "packages/ui/script/publish.ts",
    ]) {
      const source = readFileSync(resolve(root, script), "utf8")
      expect(source).toContain('process.argv.includes("--dry-run")')
      expect(source).toContain('process.argv.includes("--skip-build")')
      expect(source).toContain("const version = Script.version")
      expect(source).toContain('dryRun ? "--dry-run" : []')
      expect(source).toContain("--access public")
    }
  })

  test("plugin release replaces workspace-only SDK dependencies", () => {
    const source = readFileSync(resolve(root, "packages/plugin/script/publish.ts"), "utf8")
    expect(source).toContain('value.startsWith("workspace:") ? version : value')
  })

  test("UI release builds a packed browser consumer before publishing", () => {
    const publish = readFileSync(resolve(root, "packages/ui/script/publish.ts"), "utf8")
    const smoke = readFileSync(resolve(root, "packages/ui/script/smoke-packed.ts"), "utf8")
    const preflight = readFileSync(resolve(root, "packages/mongolgpt/script/release-preflight.ts"), "utf8")

    expect(publish.indexOf("script/smoke-packed.ts")).toBeLessThan(publish.indexOf("npm publish"))
    expect(smoke).toContain('import { Button } from "@mongolgpt/ui/button"')
    expect(smoke).toContain('import "@mongolgpt/ui/styles"')
    expect(smoke).toContain('delete publicEnv[key]')
    expect(smoke).toContain('publicEnv.NPM_CONFIG_USERCONFIG = npmrc')
    expect(smoke).toContain('["build", "entry.tsx", "--outdir", "dist", "--target", "browser", "--production"]')
    expect(smoke).toContain('outputs.some((name) => name.endsWith(".js"))')
    expect(smoke).toContain('outputs.some((name) => name.endsWith(".css"))')
    expect(preflight).toContain("public @mongolgpt/ui consumer build failed")
  })

  test("desktop release smoke contract requires a deterministic local-model inference round-trip", () => {
    const releaseSmoke = readFileSync(resolve(root, "packages/desktop/src/main/release-functional-smoke.ts"), "utf8")
    const installedSmoke = readFileSync(resolve(root, "packages/desktop/scripts/smoke-installed-windows.ps1"), "utf8")
    const sidecar = readFileSync(resolve(root, "packages/desktop/src/main/sidecar.ts"), "utf8")
    const accountGate = readFileSync(
      resolve(root, "packages/mongolgpt/src/server/routes/instance/httpapi/middleware/account-use.ts"),
      "utf8",
    )

    expect(releaseSmoke).toContain("localModelInference")
    expect(releaseSmoke).not.toContain("localModelRegisteredNoCall")
    expect(releaseSmoke).toContain('"/v1/chat/completions"')
    expect(releaseSmoke).toContain("startLocalModelServer")
    expect(releaseSmoke).toContain("`/session/${sessionID}/message`")
    expect(releaseSmoke).toContain('parts: [{ type: "text", text:')
    expect(releaseSmoke).toContain("hasLocalModelRequest(localModel.request())")
    expect(releaseSmoke).toContain("hasMessageText(value, localModelReply)")
    expect(sidecar).toContain("configureDesktopSmokeProof(command.desktopSmokeProof)")
    expect(accountGate).toContain("configuredDesktopSmokeProof")
    expect(accountGate).not.toContain("process.env.MONGOLGPT_DESKTOP_SMOKE_PROOF")
    expect(installedSmoke).toContain("$result.functional.summary.fixture.localModelInference -ne $true")
    expect(installedSmoke).not.toContain("$result.functional.summary.fixture.localModelRegisteredNoCall -ne $true")
  })
})
