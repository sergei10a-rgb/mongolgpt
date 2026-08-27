import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"

const stats = resolve(import.meta.dir, "../../stats")

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : []
    }),
  )
  return files.flat()
}

async function statsSources() {
  const files = await sourceFiles(resolve(stats, "app/src"))
  return Promise.all(files.map(async (file) => ({ file, text: await Bun.file(file).text() })))
}

describe("Public stats aggregate гэрээ", () => {
  test("нийтийн статистик plan-аар ангилахгүй бөгөөд хуучин бүтээгдэхүүний нэршилгүй байна", async () => {
    const sources = await statsSources()

    for (const { file, text } of sources) {
      const path = file.replaceAll("\\", "/")
      expect(text, path).not.toContain("MongolGPT Go")
      expect(text, path).not.toContain("product.allUsers")
      expect(text, path).not.toContain("product.zen")
      expect(text, path).not.toContain("product.go")
    }

    const core = await Bun.file(resolve(stats, "core/src/domain/home.ts")).text()
    expect(core).not.toMatch(/UsageProduct|TokenProduct|SITE_PRODUCT|rowsForProduct|normalizeTier/)
    expect(core).not.toMatch(/['\"]Go['\"]\s+as\s+tier/)
    expect(core).not.toMatch(/\bZen\b|\bEnterprise\b/)
  })
})
