type SidecarEnvOptions = {
  packaged: boolean
  platform: NodeJS.Platform
}

export function createSidecarEnv(source: NodeJS.ProcessEnv, options: SidecarEnvOptions): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  delete env.MONGOLGPT_ACCOUNT_TOKEN_KEY
  if (options.platform === "linux") delete env.LD_PRELOAD
  if (!options.packaged) env.MONGOLGPT_DISABLE_CHANNEL_DB = "1"
  return env
}
