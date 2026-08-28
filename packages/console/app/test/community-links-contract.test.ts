import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { resolveCommunityLink } from "../src/lib/community-link"

const source = (path: string) => Bun.file(resolve(import.meta.dir, "..", "src", path)).text()

describe("community link contract", () => {
  test("footer and 404 use the shared community resolver instead of locale-prefixed internal paths", async () => {
    const footer = await source("component/footer.tsx")
    const notFound = await source("routes/[...404].tsx")

    expect(footer).toContain("resolveCommunityLink")
    expect(footer).not.toContain('language.route("/discord")')
    expect(footer).not.toContain('language.route("/feishu")')

    expect(notFound).toContain("resolveCommunityLink")
    expect(notFound).not.toContain('language.route("/discord")')
    expect(notFound).not.toContain('language.route("/feishu")')
  })

  test("defaults to the MongolGPT repository community", () => {
    const result = resolveCommunityLink()
    expect(result.kind).toBe("community")
    expect(result.href).toBe("https://github.com/sergei10a-rgb/mongolgpt/discussions")
  })
})
