import { describe, expect, test } from "bun:test"
import { agentDisplayName } from "./agent"

describe("agentDisplayName", () => {
  const t = (key: "agent.builtin.build" | "agent.builtin.plan" | "agent.builtin.general") =>
    ({
      "agent.builtin.build": "Бүтээх",
      "agent.builtin.plan": "Төлөвлөх",
      "agent.builtin.general": "Ерөнхий",
    })[key]

  test("localizes built-in agent IDs", () => {
    expect(agentDisplayName("build", t)).toBe("Бүтээх")
    expect(agentDisplayName("plan", t)).toBe("Төлөвлөх")
    expect(agentDisplayName("general", t)).toBe("Ерөнхий")
  })

  test("preserves custom agent names", () => {
    expect(agentDisplayName("reviewer", t)).toBe("reviewer")
  })
})
