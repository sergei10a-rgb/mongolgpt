import { describe, expect, test } from "bun:test"
import { safeHttpsHref, safePaymentDeepLink, safeQrImage } from "./payment-display"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

describe("payment display safety", () => {
  test("accepts only syntactically valid PNG QR images within the size limit", () => {
    expect(safeQrImage(png)).toBe(`data:image/png;base64,${png}`)
    expect(safeQrImage(`data:image/png;base64,${png}`)).toBe(`data:image/png;base64,${png}`)
    expect(safeQrImage(btoa("not a png"))).toBeUndefined()
    expect(safeQrImage("%%%=")).toBeUndefined()
    expect(safeQrImage("A".repeat(2_000_004))).toBeUndefined()
  })

  test("allows HTTPS checkout pages and non-browser bank app schemes only", () => {
    expect(safeHttpsHref("https://ecommerce.bonum.mn/ecommerce?id=1")).toBe("https://ecommerce.bonum.mn/ecommerce?id=1")
    expect(safeHttpsHref("http://example.com/pay")).toBeUndefined()
    expect(safePaymentDeepLink("khanbank://q?qpay-qr")).toBe("khanbank://q?qpay-qr")
    expect(safePaymentDeepLink("https://bank.example/pay")).toBe("https://bank.example/pay")
    expect(safePaymentDeepLink("http://bank.example/pay")).toBeUndefined()
    expect(safePaymentDeepLink("javascript:alert(1)")).toBeUndefined()
  })
})
