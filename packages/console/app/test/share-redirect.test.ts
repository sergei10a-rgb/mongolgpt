import { expect, test } from "bun:test"
import { legacyShareTarget } from "../src/routes/s/[id]"

test("хуучин /s ID-г каноник /share URL болгоно", () => {
  expect(legacyShareTarget("abc_123-x", "https://share.example.com")).toBe(
    "https://share.example.com/share/abc_123-x",
  )
})

test("буруу ID болон аюултай protocol-ийг хүлээж авахгүй", () => {
  expect(legacyShareTarget("../secret", "https://share.example.com")).toBeNull()
  expect(legacyShareTarget("abc", "javascript:alert(1)")).toBeNull()
  expect(legacyShareTarget("abc", "not-a-url")).toBeNull()
})
