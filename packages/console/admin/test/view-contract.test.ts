import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

describe("MongolGPT admin overview contract", () => {
  test("keeps the operational surface Mongolian-first and branded", async () => {
    const view = await Bun.file(
      resolve(import.meta.dir, "../src/component/admin-overview.tsx"),
    ).text()

    expect(view).toContain("MongolGPT")
    expect(view).toContain("Ерөнхий хяналт")
    expect(view).toContain("Аюулгүй байдлын бүртгэл")
    expect(view).toContain("Зөвхөн харах горим")
    expect(view).toContain('owner: "Эзэмшигч"')
    expect(view).not.toContain(">Platform role<")
    expect(view).not.toContain(">Audit бүртгэл")
    expect(view).not.toContain("Lookup user")
    expect(view).not.toContain("opencode")
  })

  test("keeps compact desktop and mobile layout constraints", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../src/app.css")).text()

    expect(css).toContain('grid-template-columns: repeat(6, minmax(0, 1fr))')
    expect(css).toContain("@media (max-width: 620px)")
    expect(css).toContain("overflow-x: auto")
    expect(css).toContain("text-overflow: ellipsis")
    expect(css).not.toMatch(/border-radius:\s*(?:1[0-9]|[2-9][0-9])px/)
  })
})
