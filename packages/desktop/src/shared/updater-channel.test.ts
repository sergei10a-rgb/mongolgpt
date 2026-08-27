import { describe, expect, test } from "bun:test"
import { releaseUpdaterChannel, updaterMetadataFiles, updaterPolicy } from "./updater-channel"

describe("desktop updater channel", () => {
  test("keeps beta builds on prerelease metadata without allowing downgrades", () => {
    expect(updaterPolicy("beta")).toEqual({ channel: "beta", allowPrerelease: true, allowDowngrade: false })
    expect(updaterMetadataFiles("beta")).toEqual({
      windows: "beta.yml",
      linuxX64: "beta-linux.yml",
      linuxArm64: "beta-linux-arm64.yml",
      mac: "beta-mac.yml",
    })
  })

  test("keeps production builds on stable metadata without prereleases or downgrades", () => {
    expect(updaterPolicy("prod")).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: false })
    expect(updaterMetadataFiles("latest")).toEqual({
      windows: "latest.yml",
      linuxX64: "latest-linux.yml",
      linuxArm64: "latest-linux-arm64.yml",
      mac: "latest-mac.yml",
    })
  })

  test("fails closed when a release job does not declare its channel", () => {
    expect(releaseUpdaterChannel("beta")).toBe("beta")
    expect(releaseUpdaterChannel("prod")).toBe("latest")
    expect(releaseUpdaterChannel("latest")).toBe("latest")
    expect(() => releaseUpdaterChannel(undefined)).toThrow("MONGOLGPT_CHANNEL")
    expect(() => releaseUpdaterChannel("dev")).toThrow("MONGOLGPT_CHANNEL")
  })
})
