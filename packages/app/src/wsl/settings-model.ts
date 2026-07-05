import type { WslMongolGPTCheck, WslServerRuntime } from "./types"

export const wslRuntimeRetryable = (runtime: WslServerRuntime) =>
  runtime.kind === "failed" || runtime.kind === "stopped"

export async function enterWslMongolGPTStep(
  distro: string,
  probe: (distro: string) => Promise<unknown>,
  select: (step: "mongolgpt") => void,
) {
  await probe(distro)
  select("mongolgpt")
}

export function wslMongolGPTAction(check?: WslMongolGPTCheck) {
  if (!check) return
  if (!check.resolvedPath) return "MongolGPT суулгах"
  if (check.matchesDesktop === false) return "MongolGPT шинэчлэх"
}
