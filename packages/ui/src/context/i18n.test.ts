import { expect, test } from "bun:test"
import { useI18n } from "./i18n"

test("standalone UI defaults to Mongolian", () => {
  const i18n = useI18n()

  expect(i18n.locale()).toBe("mn")
  expect(i18n.t("ui.common.close")).toBe("Хаах")
  expect(i18n.t("ui.message.copy")).toBe("Хуулах")
})
