import { describe, expect, test } from "bun:test"

const routes = new URL("../../console/app/src/routes/", import.meta.url)

describe("hosted console legacy route contract", () => {
  test("retires the Black storefront behind a static home redirect", async () => {
    const redirect = await Bun.file(new URL("black.tsx", routes)).text()
    const legacyFiles = [
      "black.css",
      "black/common.tsx",
      "black/index.tsx",
      "black/workspace.css",
      "black/workspace.tsx",
      "black/subscribe/[plan].tsx",
    ]

    expect(redirect).toContain('<Navigate href="/" />')
    expect(redirect).not.toContain("use server")
    for (const path of legacyFiles) expect(await Bun.file(new URL(path, routes)).exists()).toBe(false)
  })
})
