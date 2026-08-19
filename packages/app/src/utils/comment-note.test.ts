import { describe, expect, test } from "bun:test"
import { formatCommentNote, parseCommentNote } from "./comment-note"

describe("comment note", () => {
  test("formats and parses a Mongolian whole-file comment", () => {
    const note = formatCommentNote({ path: "src/app.ts", comment: "Энэ нэрийг тодруулна уу." })

    expect(note).toBe("Хэрэглэгч src/app.ts файлын тухай дараах санал үлдээв: Энэ нэрийг тодруулна уу.")
    expect(parseCommentNote(note)).toEqual({
      path: "src/app.ts",
      selection: undefined,
      comment: "Энэ нэрийг тодруулна уу.",
    })
  })

  test("round-trips a Mongolian line range", () => {
    const note = formatCommentNote({
      path: "src/app.ts",
      selection: { startLine: 9, startChar: 3, endLine: 4, endChar: 8 },
      comment: "Энэ хэсгийг хялбарчил.",
    })

    expect(parseCommentNote(note)).toEqual({
      path: "src/app.ts",
      selection: { startLine: 4, startChar: 0, endLine: 9, endChar: 0 },
      comment: "Энэ хэсгийг хялбарчил.",
    })
  })

  test("round-trips a Mongolian single-line comment", () => {
    const note = formatCommentNote({
      path: "src/app.ts",
      selection: { startLine: 7, startChar: 2, endLine: 7, endChar: 9 },
      comment: "Энэ нэрийг солино уу.",
    })

    expect(note).toBe("Хэрэглэгч src/app.ts файлын 7-р мөрийн тухай дараах санал үлдээв: Энэ нэрийг солино уу.")
    expect(parseCommentNote(note)).toEqual({
      path: "src/app.ts",
      selection: { startLine: 7, startChar: 0, endLine: 7, endChar: 0 },
      comment: "Энэ нэрийг солино уу.",
    })
  })

  test("preserves multiline comment text", () => {
    const note = formatCommentNote({
      path: "src/app.ts",
      comment: "Эхний мөр.\nХоёр дахь мөр.",
    })

    expect(parseCommentNote(note)?.comment).toBe("Эхний мөр.\nХоёр дахь мөр.")
  })

  test("parses persisted English notes for backward compatibility", () => {
    expect(
      parseCommentNote("The user made the following comment regarding line 7 of src/app.ts: Keep this."),
    ).toEqual({
      path: "src/app.ts",
      selection: { startLine: 7, startChar: 0, endLine: 7, endChar: 0 },
      comment: "Keep this.",
    })
  })
})
