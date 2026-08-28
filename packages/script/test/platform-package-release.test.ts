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
})
