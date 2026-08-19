import { expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

test("exposes Mongolian UI labels for common TUI actions and statuses", () => {
  expect(Locale.ui).toMatchObject({
    closeDialog: "Диалог хаах",
    directory: "Хавтас",
    file: "Файл",
    getStarted: "Эхлэхийн тулд",
    lspDisabled: "LSP идэвхгүй байна",
    lspActivates: "Файл уншихад LSP идэвхжинэ",
    next: "Дараагийн",
    parent: "Эх сесс",
    previous: "Өмнөх",
    showKeyboardShortcuts: "Гарын товчлолыг харах",
  })
  expect(
    Object.values(Locale.ui).some((label) =>
      /\b(?:Close|Directory|File|Get started|Parent|Prev|Next|Show|disabled|activate)\b/i.test(label),
    ),
  ).toBe(false)
})
