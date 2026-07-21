import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"

const roots = [
  new URL("../../app/src/", import.meta.url),
  new URL("../../ui/src/", import.meta.url),
  new URL("../../tui/src/", import.meta.url),
  new URL("../../mongolgpt/src/", import.meta.url),
  new URL("../../core/src/", import.meta.url),
]

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
      if (entry.isDirectory()) return sourceFiles(child)
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return []
      return [child]
    }),
  )
  return files.flat()
}

describe("runtime legacy brand contract", () => {
  test("keeps retired Zen and Go product names out of active clients", async () => {
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const source = await Bun.file(file).text()
        expect(source).not.toMatch(/MongolGPT (?:Zen|Go)\b/)
        expect(source).not.toMatch(/mongolgpt(?:Zen|Go)/)
      }
    }
  })

  test("routes managed usage limits through current pricing and billing", async () => {
    const retry = await Bun.file(new URL("../../mongolgpt/src/session/retry.ts", import.meta.url)).text()
    const appPrompt = await Bun.file(
      new URL("../../app/src/pages/session/usage-exceeded-dialogs.tsx", import.meta.url),
    ).text()
    const providerDialog = await Bun.file(
      new URL("../../tui/src/component/dialog-provider.tsx", import.meta.url),
    ).text()

    expect(retry).toContain("`${consoleUrl}/pricing`")
    expect(retry).toContain("`${consoleUrl}/workspace/${workspace}/billing`")
    expect(retry).not.toContain("`${consoleUrl}/go`")
    expect(appPrompt).not.toContain('DialogConnectProvider provider="mongolgpt-go"')
    expect(providerDialog).toContain('provider.id !== "mongolgpt-go"')
  })
})
