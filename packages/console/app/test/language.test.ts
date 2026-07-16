import { expect, test } from "bun:test"
import { docs } from "../src/lib/language"

test("бүх хэлний docs холбоос Монгол каноник замыг ашиглана", () => {
  expect(docs("mn", "/docs/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/providers")).toBe("/docs/providers")
  expect(docs("zh", "/docs")).toBe("/docs")
  expect(docs("mn", "/docs/mn/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/en/")).toBe("/docs/")
})
