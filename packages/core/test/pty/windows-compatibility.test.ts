import { describe, expect, test } from "bun:test"
import { windowsPtyCompatibilityOptions } from "../../src/pty"

describe("Windows PTY compatibility", () => {
  test("uses the bundled ConPTY backend only when explicitly requested", () => {
    expect(windowsPtyCompatibilityOptions("win32", { MONGOLGPT_PTY_USE_CONPTY_DLL: "1" })).toEqual({
      useConptyDll: true,
    })
    expect(windowsPtyCompatibilityOptions("win32", {})).toEqual({})
    expect(windowsPtyCompatibilityOptions("linux", { MONGOLGPT_PTY_USE_CONPTY_DLL: "1" })).toEqual({})
  })
})
