import { expect, test } from "bun:test"
import { SessionCompaction } from "@mongolgpt/core/session/compaction"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Хавсралт image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction builds a Mongolian prompt and preserves anchored summary tags", () => {
  const initial = SessionCompaction.buildPrompt({ context: ["[Хэрэглэгч]: Туршилт"] })
  expect(initial).toContain("Харилцан ярианы түүхээс шинэ суурь хураангуй үүсгэ.")
  expect(initial).toContain("## Зорилго")

  const updated = SessionCompaction.buildPrompt({
    previousSummary: "## Зорилго\n- Өмнөх зорилго",
    context: ["[Хэрэглэгч]: Шинэ баримт"],
  })
  expect(updated).toContain("Доорх суурь хураангуйг дээрх харилцан ярианы түүхээр шинэчил.")
  expect(updated).toContain("<previous-summary>\n## Зорилго\n- Өмнөх зорилго\n</previous-summary>")
})
