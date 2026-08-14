import { expect, test } from "bun:test"
import { docs } from "../src/lib/language"
import { i18n } from "../src/i18n"
import { dict as en } from "../src/i18n/en"
import { dict as mn } from "../src/i18n/mn"

test("бүх хэлний docs холбоос Монгол каноник замыг ашиглана", () => {
  expect(docs("mn", "/docs/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/providers")).toBe("/docs/providers")
  expect(docs("zh", "/docs")).toBe("/docs")
  expect(docs("mn", "/docs/mn/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/en/")).toBe("/docs/")
})

test("locale dictionaries return English and Mongolian billing/error copy", () => {
  expect(i18n("en")["zen.api.error.missingApiKey"]).toBe("Missing API key.")
  expect(i18n("mn")["zen.api.error.missingApiKey"]).toBe("API түлхүүр дутуу байна.")
  expect(Object.keys(mn).sort()).toEqual(Object.keys(en).sort())
})
