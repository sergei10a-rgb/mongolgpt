import { expect, test } from "bun:test"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"

test("handoff identity rejection retains a safe reason without exposing packet details", async () => {
  const error = await StartupHandoff.accept("/private-workspace").catch((error: unknown) => error)
  expect(error).toBeInstanceOf(StartupHandoff.HandoffError)
  expect(Object.getOwnPropertyDescriptor(error, "code")?.value).toBe("handoff_identity")
  expect((error as Error).message).toBe(new StartupHandoff.HandoffError().message)
  expect((error as Error).message).not.toContain("private-workspace")
})
