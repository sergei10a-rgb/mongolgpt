declare global {
  const MONGOLGPT_VERSION: string
  const MONGOLGPT_CHANNEL: string
}

export const InstallationVersion = typeof MONGOLGPT_VERSION === "string" ? MONGOLGPT_VERSION : "local"
export const InstallationChannel = typeof MONGOLGPT_CHANNEL === "string" ? MONGOLGPT_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
