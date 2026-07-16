import { expect, test } from "bun:test"
import { extractShareUrl, parseShareUrl } from "../../src/share/url"

test("каноник share URL-аас ID-г уншина", () => {
  expect(parseShareUrl("https://example.invalid/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("хуучин эсвэл эрсдэлтэй share URL-г хүлээж авахгүй", () => {
  expect(parseShareUrl("https://example.invalid/s/Jsj3hNIW")).toBeNull()
  expect(parseShareUrl("https://user:secret@example.invalid/share/abc")).toBeNull()
  expect(parseShareUrl("https://example.invalid/share/abc?token=secret")).toBeNull()
  expect(parseShareUrl("https://example.invalid/share/abc#fragment")).toBeNull()
  expect(parseShareUrl("https://example.invalid/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("текст дундаас зөвхөн каноник share URL-г олно", () => {
  expect(extractShareUrl("Хуучин https://example.invalid/s/old, шинэ https://example.invalid/share/new_id.")).toBe(
    "https://example.invalid/share/new_id",
  )
  expect(extractShareUrl("[Сешн](https://example.invalid/share/markdown-id)")).toBe(
    "https://example.invalid/share/markdown-id",
  )
  expect(extractShareUrl("Share холбоос алга")).toBeNull()
})
