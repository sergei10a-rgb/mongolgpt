import { describe, expect, test } from "bun:test"
import INITIALIZE from "../../src/plugin/command/initialize.txt"
import REVIEW from "../../src/plugin/command/review.txt"

describe("built-in command localization", () => {
  test("initialize prompt is Mongolian and preserves invocation contracts", () => {
    expect(INITIALIZE).toContain("$ARGUMENTS")
    expect(INITIALIZE).toContain("${path}")
    expect(INITIALIZE).toContain("AGENTS.md")
    expect(INITIALIZE.match(/Сайн `AGENTS\.md`/g)).toHaveLength(1)
    expect(INITIALIZE).not.toContain("Create or update")
  })

  test("review prompt is Mongolian and preserves Git commands", () => {
    expect(REVIEW).toContain("$ARGUMENTS")
    expect(REVIEW).toContain("git diff --cached")
    expect(REVIEW).toContain("git diff $ARGUMENTS...HEAD")
    expect(REVIEW).toContain("gh pr diff $ARGUMENTS")
    expect(REVIEW).not.toContain("You are a code reviewer")
  })
})
