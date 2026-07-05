import type { WslDistroProbe, WslMongolGPTCheck, WslServerItem } from "../../preload/types"

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  mongolgptChecks: Record<string, WslMongolGPTCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextMongolGPTChecks = { ...mongolgptChecks }
  delete nextDistroProbes[distro]
  delete nextMongolGPTChecks[distro]
  return { distroProbes: nextDistroProbes, mongolgptChecks: nextMongolGPTChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  return ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])]
}

export function requireWslIpcString(name: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Invalid ${name}`)
}
