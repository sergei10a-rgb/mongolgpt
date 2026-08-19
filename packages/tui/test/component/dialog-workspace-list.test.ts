import { describe, expect, test } from "bun:test"
import { workspaceDeleteConfirmationTitle } from "../../src/component/dialog-workspace-list"

describe("ажлын орчин устгах баталгаажуулалт", () => {
  test("англи Delete үгийн оронд Монгол баталгаажуулалт харуулна", () => {
    const title = workspaceDeleteConfirmationTitle("demo")

    expect(title).toBe("demo-г устгах уу? Баталгаажуулахын тулд устгах товчийг дахин дарна уу")
    expect(title).not.toContain("Delete")
  })
})
