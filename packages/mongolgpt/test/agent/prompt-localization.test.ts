import { describe, expect, test } from "bun:test"
import GENERATE from "../../src/agent/generate.txt"
import COMPACTION from "../../src/agent/prompt/compaction.txt"
import SUMMARY from "../../src/agent/prompt/summary.txt"
import TITLE from "../../src/agent/prompt/title.txt"

describe("built-in agent prompt localization", () => {
  test("agent generator is Mongolian and preserves its JSON contract", () => {
    expect(GENERATE).toContain("монгол хэлээр")
    expect(GENERATE).toContain("Task tool")
    expect(GENERATE).not.toContain("You are an elite AI agent architect")

    const start = GENERATE.indexOf("{\n")
    const end = GENERATE.indexOf("\n}", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const template = JSON.parse(GENERATE.slice(start, end + 2))
    expect(Object.keys(template)).toEqual(["identifier", "whenToUse", "systemPrompt"])
  })

  test("compaction prompt preserves anchored summary contracts", () => {
    expect(COMPACTION).toContain("<previous-summary>")
    expect(COMPACTION).toContain("file path")
    expect(COMPACTION).toContain("ижил хэлээр")
    expect(COMPACTION).not.toContain("You are an anchored context summarization assistant")
  })

  test("summary prompt keeps exact trailing-request behavior", () => {
    expect(SUMMARY).toContain("2-3 өгүүлбэр")
    expect(SUMMARY).toContain("яг хэвээр")
    expect(SUMMARY).toContain("монгол хэлээр")
    expect(SUMMARY).not.toContain("Summarize what was done")
  })

  test("title prompt preserves structure and technical examples", () => {
    expect(TITLE).toContain("<task>")
    expect(TITLE).toContain("<rules>")
    expect(TITLE).toContain("<examples>")
    expect(TITLE).toContain("50-аас ихгүй")
    expect(TITLE).toContain("HTTP code")
    expect(TITLE).toContain("@src/auth.ts")
    expect(TITLE).not.toContain("You are a title generator")
  })
})
