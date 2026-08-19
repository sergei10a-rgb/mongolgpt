import { describe, expect, test } from "bun:test"
import { localeFromRequest } from "./language"

describe("MongolGPT Data-ийн анхдагч хэл", () => {
  test("browser-ийн хэлээс үл хамааран Монгол байна", () => {
    const request = new Request("https://data.mgpt.mn/", {
      headers: { "accept-language": "en-US,en;q=0.9" },
    })
    expect(localeFromRequest(request)).toBe("mn")
  })

  test("server болон client fallback Монгол байна", async () => {
    const server = await Bun.file(new URL("../entry-server.tsx", import.meta.url)).text()
    const client = await Bun.file(new URL("../context/language.tsx", import.meta.url)).text()
    expect(server).toContain('event ? localeFromRequest(event.request) : "mn"')
    expect(client).toContain('return "mn" satisfies Locale')
    expect(server).not.toContain('event ? localeFromRequest(event.request) : "en"')
  })
})
