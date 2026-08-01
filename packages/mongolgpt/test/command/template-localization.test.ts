import { describe, expect, test } from "bun:test"
import EXPLORE from "../../src/agent/prompt/explore.txt"
import INITIALIZE from "../../src/command/template/initialize.txt"
import REVIEW from "../../src/command/template/review.txt"

describe("built-in command template localization", () => {
  test("init template is Mongolian and preserves invocation contracts", () => {
    expect(INITIALIZE).toContain("монгол хэлээр")
    expect(INITIALIZE).toContain("$ARGUMENTS")
    expect(INITIALIZE).toContain("${path}")
    expect(INITIALIZE).toContain("AGENTS.md")
    expect(INITIALIZE).not.toContain("Create or update")
    expect(INITIALIZE).not.toContain("The goal is")
  })

  test("review template is Mongolian and preserves tool and argument names", () => {
    expect(REVIEW).toContain("Эцсийн хариуг монгол хэлээр")
    expect(REVIEW).toContain("$ARGUMENTS")
    expect(REVIEW).toContain("Explore agent")
    expect(REVIEW).toContain("Exa Code Context")
    expect(REVIEW).toContain("Web Search")
    expect(REVIEW).not.toContain("You are a code reviewer")
    expect(REVIEW).not.toContain("Based on the input provided")
  })

  test("explore guidance is Mongolian and preserves tool contracts", () => {
    expect(EXPLORE).toContain("монгол хэлээр")
    expect(EXPLORE).toContain("Glob")
    expect(EXPLORE).toContain("Grep")
    expect(EXPLORE).toContain("Read")
    expect(EXPLORE).toContain("Bash")
    expect(EXPLORE).toContain("absolute path")
    expect(EXPLORE).not.toContain("You are a file search specialist")
  })
})
