import path from "node:path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

describe("actual TCP cloud startup", () => {
  for (const mode of ["ready", "failure"]) {
    test(`uses canonical EventV2 and native recovery (${mode})`, async () => {
      await using directory = await tmpdir()
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "../fixture/cloud-startup.ts"),
          directory.path,
          mode,
        ],
        {
          cwd: path.join(import.meta.dir, "../.."),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => child.kill(), 55_000)
      const output = Bun.readableStreamToText(child.stdout)
      const errors = Bun.readableStreamToText(child.stderr)
      try {
        expect(await child.exited, await errors).toBe(0)
        expect(await output).toContain(
          JSON.stringify({ cloudStartup: mode === "ready" ? "recovered-and-fenced" : "closed-on-failure" }),
        )
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }
    }, 60_000)
  }
})
