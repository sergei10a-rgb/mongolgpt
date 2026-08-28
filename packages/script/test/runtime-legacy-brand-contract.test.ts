import { describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"

const roots = [
  new URL("../../app/src/", import.meta.url),
  new URL("../../console/admin/src/", import.meta.url),
  new URL("../../console/app/src/", import.meta.url),
  new URL("../../console/function/src/", import.meta.url),
  new URL("../../desktop/src/", import.meta.url),
  new URL("../../ui/src/", import.meta.url),
  new URL("../../tui/src/", import.meta.url),
  new URL("../../mongolgpt/src/", import.meta.url),
  new URL("../../web/src/", import.meta.url),
]

const apiRoots = [...roots, new URL("../../core/src/", import.meta.url)]

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
      if (entry.isDirectory()) return sourceFiles(child)
      if (!/\.(?:tsx?|css)$/.test(entry.name) || entry.name.includes(".test.")) return []
      return [child]
    }),
  )
  return files.flat()
}

async function sourceText(file: URL) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

describe("runtime legacy brand contract", () => {
  test("keeps the upstream brand out of active product source", async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat()
    const sources = await Promise.all(files.map(sourceText))
    for (const source of sources) {
      if (source === undefined) continue
      expect(source).not.toMatch(/\bOpenCode\b/)
      expect(source).not.toContain("opencode.ai")
      expect(source).not.toContain("anomalyco")
    }
  })

  test("keeps retired Zen and Go product names out of active clients", async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat()
    const sources = await Promise.all(files.map(sourceText))
    for (const source of sources) {
      if (source === undefined) continue
      expect(source).not.toMatch(/MongolGPT (?:Zen|Go)\b/)
      expect(source).not.toMatch(/mongolgpt(?:Zen|Go)/)
      expect(source).not.toContain("mongolgpt-go")
      expect(source).not.toContain("opencode-go")
      expect(source).not.toMatch(/data-slot=["']zen\b/i)
    }
  })

  test("keeps retired Zen API paths out of active clients", async () => {
    const files = (await Promise.all(apiRoots.map(sourceFiles))).flat()
    const sources = await Promise.all([
      ...files.map(sourceText),
      sourceText(new URL("../../console/app/src/routes/api/account-config.ts", import.meta.url)),
    ])

    for (const source of sources) {
      if (source === undefined) continue
      expect(source).not.toContain("/zen/v1")
    }

    const models = await Bun.file(new URL("../../core/src/models-dev.ts", import.meta.url)).text()
    const accountConfig = await Bun.file(
      new URL("../../console/app/src/routes/api/account-config.ts", import.meta.url),
    ).text()
    expect(models).toContain("/gateway/v1")
    expect(accountConfig).toContain("/gateway/v1")
  })

  test("routes managed Free Auto limits through current pricing", async () => {
    const retry = await Bun.file(new URL("../../mongolgpt/src/session/retry.ts", import.meta.url)).text()
    const appPrompt = await Bun.file(
      new URL("../../app/src/pages/session/usage-exceeded-dialogs.tsx", import.meta.url),
    ).text()
    const providerDialog = await Bun.file(
      new URL("../../tui/src/component/dialog-provider.tsx", import.meta.url),
    ).text()

    expect(retry).toContain("`${consoleUrl}/pricing`")
    expect(retry).not.toContain("GoUsageLimitError")
    expect(retry).not.toContain("`${consoleUrl}/go`")
    expect(appPrompt).not.toContain('DialogConnectProvider provider="mongolgpt-go"')
    expect(providerDialog).not.toContain("mongolgpt-go")
  })
})
