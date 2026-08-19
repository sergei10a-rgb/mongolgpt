import { expect, test } from "bun:test"
import { SPLASH_TITLE_FALLBACK, splashMeta } from "@/cli/cmd/run/splash"

test("uses a Mongolian fallback for sessions without a title", () => {
  expect(SPLASH_TITLE_FALLBACK).toBe("Гарчиггүй сесс")
  expect(splashMeta({ title: undefined, session_id: "session-1" })).toEqual({
    title: "Гарчиггүй сесс",
    session_id: "session-1",
  })
  expect(splashMeta({ title: " \n\t ", session_id: "session-2" }).title).toBe("Гарчиггүй сесс")
})
