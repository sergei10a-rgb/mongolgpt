import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("ad-hoc signing is opt-in for dev and cannot weaken beta or production", async () => {
  for (const channel of ["dev", "beta", "prod"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'import config from "./electron-builder.mac-preview.config.ts"; console.log(JSON.stringify(config))',
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, MONGOLGPT_CHANNEL: channel },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const text = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited).toBe(channel === "dev" ? 0 : 1)
    if (channel !== "dev") {
      expect(error).toContain("restricted to explicit dev previews")
      continue
    }
    const config = JSON.parse(text)
    expect(config.appId).toBe("org.mongolgpt.desktop.dev")
    expect(config.mac.identity).toBe("-")
    expect(config.mac.notarize).toBe(false)
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(config.dmg.sign).toBe(false)
    expect(config.publish).toBeUndefined()
  }
})
