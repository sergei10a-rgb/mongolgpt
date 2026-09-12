import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { formatAdminDate } from "../src/lib/admin-date"
import {
  adminAuditActionLabel,
  adminAuditTargetLabel,
  adminPaymentStatusLabel,
  adminPlanLabel,
} from "../src/lib/admin-labels"

describe("Mongolian admin dates", () => {
  test.each([
    ["2026-08-31T17:20:00Z", "2026 оны 9-р сарын 1, 01:20"],
    ["2026-12-31T16:00:00Z", "2027 оны 1-р сарын 1, 00:00"],
    ["2024-02-29T15:59:00Z", "2024 оны 2-р сарын 29, 23:59"],
    ["2024-02-29T16:00:00Z", "2024 оны 3-р сарын 1, 00:00"],
    ["2026-09-12T12:05:00+08:00", "2026 оны 9-р сарын 12, 12:05"],
  ])("formats %s in Ulaanbaatar without locale fallback", (input, expected) => {
    expect(formatAdminDate(input)).toBe(expected)
    expect(formatAdminDate(new Date(input))).toBe(expected)
    expect(formatAdminDate(Date.parse(input))).toBe(expected)
  })

  test("distinguishes absent, invalid and epoch dates", () => {
    for (const value of [null, undefined, ""]) expect(formatAdminDate(value)).toBe("-")
    for (const value of ["invalid", new Date(NaN), NaN, Infinity]) {
      expect(formatAdminDate(value)).toBe("Тодорхойгүй огноо")
    }
    expect(formatAdminDate(0)).toBe("1970 оны 1-р сарын 1, 07:00")
  })

  test("all date-bearing views use the shared formatter", async () => {
    const root = resolve(import.meta.dir, "../src")
    const glob = new Bun.Glob("{routes,component}/**/*.tsx")
    for await (const path of glob.scan(root)) {
      const source = await Bun.file(resolve(root, path)).text()
      expect(source).not.toMatch(/Intl\.DateTimeFormat|\.toLocale(?:Date|Time)?String\(/)
      if (source.includes("function formatDate(")) expect(source).toContain("return formatAdminDate(value)")
    }
  })

  test("billing report periods wrap instead of truncating the end date", async () => {
    const root = resolve(import.meta.dir, "../src")
    const view = await Bun.file(resolve(root, "component/admin-billing.tsx")).text()
    const css = await Bun.file(resolve(root, "app.css")).text()
    expect(view).toContain("<strong data-report-period>")
    expect(css).toMatch(/strong\[data-report-period\]\s*\{[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;/)
  })
})

describe("Mongolian admin labels", () => {
  test("shows localized plans while retaining their product names", () => {
    expect(["free", "basic", "pro", "max"].map(adminPlanLabel)).toEqual([
      "Үнэгүй",
      "Үндсэн (Basic)",
      "Про (Pro)",
      "Дээд (Max)",
    ])
    expect(adminPlanLabel(null)).toBe("-")
    expect(adminPlanLabel("future-plan")).toBe("Тодорхойгүй багц (future-plan)")
  })

  test("localizes payment states without hiding unknown status codes", () => {
    expect(
      ["created", "pending", "paid", "failed", "expired", "cancelled", "refunded"].map(adminPaymentStatusLabel),
    ).toEqual(["Үүссэн", "Хүлээгдэж буй", "Төлөгдсөн", "Амжилтгүй", "Хугацаа дууссан", "Цуцлагдсан", "Буцаасан"])
    expect(adminPaymentStatusLabel(null)).toBe("-")
    expect(adminPaymentStatusLabel("disputed")).toBe("Тодорхойгүй төлөв (disputed)")
  })

  test("adds human audit labels without replacing forensic identifiers", async () => {
    expect(adminAuditActionLabel("plans.rollback")).toBe("Багцын өмнөх хязгаарыг сэргээх")
    expect(adminAuditActionLabel("payment_recovery.retry")).toBe("Төлбөрийн боловсруулалтыг дахин товлох")
    expect(adminAuditActionLabel("unknown.action")).toBe("Бусад үйлдэл")
    expect(adminAuditTargetLabel("payment_invoice")).toBe("Төлбөрийн нэхэмжлэх")
    expect(adminAuditTargetLabel(null)).toBe("-")
    expect(adminAuditTargetLabel("unknown_target")).toBe("Бусад объект (unknown_target)")
    for (const path of ["routes/audit/index.tsx", "component/admin-overview.tsx"]) {
      const source = await Bun.file(resolve(import.meta.dir, "../src", path)).text()
      expect(source).toContain("adminAuditActionLabel(entry.action)")
      expect(source).toMatch(/<code[^>]*>\{entry.action\}<\/code>/)
    }
  })

  test("prototype keys are not mistaken for known enum values", () => {
    for (const value of ["__proto__", "constructor", "toString"]) {
      expect(adminPlanLabel(value)).toBe(`Тодорхойгүй багц (${value})`)
      expect(adminPaymentStatusLabel(value)).toBe(`Тодорхойгүй төлөв (${value})`)
      expect(adminAuditActionLabel(value)).toBe("Бусад үйлдэл")
      expect(adminAuditTargetLabel(value)).toBe(`Бусад объект (${value})`)
    }
  })
})
