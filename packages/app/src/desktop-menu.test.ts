import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"
import { supportUrl } from "./product"

describe("desktop support menu", () => {
  test("routes customer help, feedback, and error reports to MongolGPT Support", () => {
    const help = DESKTOP_MENU.find((menu) => menu.id === "help")
    const customerItems = help?.items?.filter(
      (item) =>
        item.type === "item" &&
        ["Тусламж ба асуудал мэдээлэх", "Санал хүсэлт илгээх", "Алдаа мэдээлэх"].includes(item.label ?? ""),
    )

    expect(customerItems).toHaveLength(3)
    expect(customerItems?.map((item) => (item.type === "item" ? item.href : undefined))).toEqual([
      supportUrl,
      supportUrl,
      supportUrl,
    ])
    expect(JSON.stringify(customerItems)).not.toContain("github.com")
    expect(JSON.stringify(customerItems)).not.toContain("discord")
  })
})
