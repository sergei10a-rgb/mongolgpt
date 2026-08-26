import { expect, test } from "bun:test"
import TODO_WRITE from "../../src/tool/todowrite.txt"

test("todo prompt is Mongolian and preserves status contracts", () => {
  expect(TODO_WRITE).toContain("даалгаврын жагсаалт")
  expect(TODO_WRITE).toContain("`pending`")
  expect(TODO_WRITE).toContain("`in_progress`")
  expect(TODO_WRITE).toContain("`completed`")
  expect(TODO_WRITE).toContain("`cancelled`")
  expect(TODO_WRITE).not.toContain("coding session")
  expect(TODO_WRITE).not.toContain("todo list")
})
