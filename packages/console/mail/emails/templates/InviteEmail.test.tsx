import { describe, expect, test } from "bun:test"
import type { ReactElement, ReactNode } from "react"
import { InviteEmail } from "./InviteEmail"

describe("MongolGPT invitation email", () => {
  test("links the logo home and invitation action to canonical console routes", () => {
    const email = InviteEmail({
      inviter: "admin@example.com",
      workspaceID: "wrk_01K6XFY7V53T8XN0A7X8G9BTN3",
      workspaceName: "Туршилтын баг",
      consoleUrl: "https://dev.mgpt.mn/",
      assetsUrl: "https://dev.mgpt.mn/email",
    })

    expect(links(email)).toEqual([
      "https://dev.mgpt.mn/",
      "https://dev.mgpt.mn/workspace/wrk_01K6XFY7V53T8XN0A7X8G9BTN3",
      "https://dev.mgpt.mn/workspace/wrk_01K6XFY7V53T8XN0A7X8G9BTN3",
    ])
  })
})

function links(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(links)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as ReactElement<{ href?: unknown; children?: ReactNode }>
  const own = typeof element.props.href === "string" ? [element.props.href] : []
  return [...own, ...links(element.props.children)]
}
