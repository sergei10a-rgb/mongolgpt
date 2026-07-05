import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/mongolgpt-desktop.desktop"

const channels = [
  { channel: "dev", appId: "org.mongolgpt.desktop.dev" },
  { channel: "beta", appId: "org.mongolgpt.desktop.beta" },
  { channel: "prod", appId: "org.mongolgpt.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.MONGOLGPT_CHANNEL
    process.env.MONGOLGPT_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.MONGOLGPT_CHANNEL
    else process.env.MONGOLGPT_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.MONGOLGPT_CHANNEL
  process.env.MONGOLGPT_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.MONGOLGPT_CHANNEL
  else process.env.MONGOLGPT_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/mongolgpt-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/mongolgpt-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/MongolGPT/org.mongolgpt.desktop %U")
  expect(desktop).toContain("Icon=org.mongolgpt.desktop")
  expect(desktop).toContain("StartupWMClass=org.mongolgpt.desktop")
  expect(desktop).toContain("NoDisplay=true")
})
