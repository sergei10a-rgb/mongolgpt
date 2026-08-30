import { describe, expect, test } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"

describe("ConfigPaths.displayConfigSource", () => {
  test("hides legacy config branding in Unix and Windows paths", () => {
    expect(ConfigPaths.displayConfigSource("/workspace/.opencode/opencode.json")).toBe(
      "өмнөх хувилбарын нийцтэй тохиргоо",
    )
    expect(ConfigPaths.displayConfigSource("C:\\workspace\\opencode.jsonc")).toBe(
      "өмнөх хувилбарын нийцтэй тохиргоо",
    )
  })

  test("keeps MongolGPT config paths actionable", () => {
    const source = "C:\\workspace\\.mongolgpt\\mongolgpt.json"
    expect(ConfigPaths.displayConfigSource(source)).toBe(source)
  })
})
