export type DesktopChannel = "dev" | "beta" | "prod"
export type UpdaterChannel = "beta" | "latest"

export function updaterChannel(channel: DesktopChannel): UpdaterChannel {
  return channel === "beta" ? "beta" : "latest"
}

export function releaseUpdaterChannel(value: string | undefined): UpdaterChannel {
  if (value === "beta") return "beta"
  if (value === "latest" || value === "prod") return "latest"
  throw new Error("MONGOLGPT_CHANNEL нь beta, latest эсвэл prod байх ёстой")
}

export function updaterPolicy(channel: DesktopChannel) {
  return {
    channel: updaterChannel(channel),
    allowPrerelease: channel === "beta",
    allowDowngrade: false,
  } as const
}

export function updaterMetadataFiles(channel: UpdaterChannel) {
  return {
    windows: `${channel}.yml`,
    linuxX64: `${channel}-linux.yml`,
    linuxArm64: `${channel}-linux-arm64.yml`,
    mac: `${channel}-mac.yml`,
  } as const
}
