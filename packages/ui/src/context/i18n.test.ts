import { expect, test } from "bun:test"
import { dict as en } from "../i18n/en"
import { dict as mn } from "../i18n/mn"
import { useI18n } from "./i18n"

test("standalone UI defaults to Mongolian", () => {
  const i18n = useI18n()

  expect(i18n.locale()).toBe("mn")
  expect(i18n.t("ui.common.close")).toBe("Хаах")
  expect(i18n.t("ui.message.copy")).toBe("Хуулах")
})

test("Mongolian UI dictionary covers English without visible fallbacks", () => {
  expect(Object.keys(mn).sort()).toEqual(Object.keys(en).sort())

  const emptySuffixes = new Set([
    "ui.lineComment.label.suffix",
    "ui.lineComment.editorLabel.suffix",
    "ui.list.emptyWithFilter.suffix",
  ])
  for (const [key, english] of Object.entries(en)) {
    const mongolian = mn[key as keyof typeof mn]
    if (mongolian === english) expect(emptySuffixes.has(key)).toBe(true)
    expect(mongolian.match(/{{[^}]+}}/g)?.sort() ?? []).toEqual(english.match(/{{[^}]+}}/g)?.sort() ?? [])
  }
})
