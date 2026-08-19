import { spawnSync } from "node:child_process"
import { userInfo } from "node:os"
import { basename } from "node:path"

const TIMEOUT = 5_000

type Probe = { type: "Loaded"; value: Record<string, string> } | { type: "Timeout" } | { type: "Unavailable" }
type ShellEnvLogger = {
  log: (message: string) => void
}

export function resolveUserShell(envShell: string | undefined, loginShell: string | null | undefined) {
  const resolvedLoginShell = loginShell && loginShell !== "unknown" ? loginShell : undefined
  return envShell || resolvedLoginShell || "/bin/sh"
}

export function getUserShell() {
  try {
    return resolveUserShell(process.env.SHELL, userInfo().shell)
  } catch {
    return resolveUserShell(process.env.SHELL, undefined)
  }
}

export function parseShellEnv(out: Buffer) {
  const env: Record<string, string> = {}
  for (const line of out.toString("utf8").split("\0")) {
    if (!line) continue
    const ix = line.indexOf("=")
    if (ix <= 0) continue
    env[line.slice(0, ix)] = line.slice(ix + 1)
  }
  return env
}

function probe(shell: string, mode: "-il" | "-l"): Probe {
  const out = spawnSync(shell, [mode, "-c", "env -0"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TIMEOUT,
    windowsHide: true,
  })

  const err = out.error as NodeJS.ErrnoException | undefined
  if (err) {
    if (err.code === "ETIMEDOUT") return { type: "Timeout" }
    console.log(`[server] Shell орчны шалгалт амжилтгүй боллоо: ${shell} ${mode}: ${err.message}`)
    return { type: "Unavailable" }
  }

  if (out.status !== 0) {
    console.log(`[server] Shell орчны шалгалт тэгээс өөр төлөвтэй дууслаа: ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  const env = parseShellEnv(out.stdout)
  if (Object.keys(env).length === 0) {
    console.log(`[server] Shell орчны шалгалт хоосон орчин буцаалаа: ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  return { type: "Loaded", value: env }
}

export function isNushell(shell: string) {
  const name = basename(shell).toLowerCase()
  const raw = shell.toLowerCase()
  return name === "nu" || name === "nu.exe" || raw.endsWith("\\nu.exe")
}

export function loadShellEnv(shell: string, logger: ShellEnvLogger) {
  if (isNushell(shell)) {
    logger.log(`[server] nushell-ийн shell орчны шалгалтыг алгаслаа: ${shell}`)
    return null
  }

  const interactive = probe(shell, "-il")
  if (interactive.type === "Loaded") {
    logger.log(`[server] Shell орчныг -il горимоор ачааллаа (${Object.keys(interactive.value).length} хувьсагч)`)
    return interactive.value
  }
  if (interactive.type === "Timeout") {
    logger.log(`[server] Интерактив shell орчны шалгалтын хугацаа дууслаа: ${shell}`)
    return null
  }

  const login = probe(shell, "-l")
  if (login.type === "Loaded") {
    logger.log(`[server] Shell орчныг -l горимоор ачааллаа (${Object.keys(login.value).length} хувьсагч)`)
    return login.value
  }

  logger.log(`[server] Аппын орчинд буцаж ашиглаж байна: ${shell}`)
  return null
}

export function mergeShellEnv(shell: Record<string, string> | null, env: Record<string, string>) {
  return {
    ...shell,
    ...env,
  }
}
