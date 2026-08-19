import { describe, expect, test } from "bun:test"

describe("desktop runtime-ийн Монгол fallback мэдээлэл", () => {
  test("renderer protocol-ийн 404 хариу Монгол байна", async () => {
    const source = await Bun.file(new URL("./windows.ts", import.meta.url)).text()
    expect(source).toContain('new Response("Олдсонгүй", { status: 404 })')
    expect(source).not.toContain('new Response("Not found", { status: 404 })')
  })
})
