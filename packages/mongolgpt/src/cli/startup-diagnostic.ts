import { open, statfs } from "node:fs/promises"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { checkpointControlHeader, validControlToken } from "@mongolgpt/runtime-auth/control"
import {
  parseStartupDiagnostic,
  startupDiagnosticCodes,
  startupDiagnosticEnv,
  startupDiagnosticPath,
} from "@mongolgpt/runtime-auth/startup-diagnostic"

/** Canary-only root failure evidence. Never forward the switch or control token to workspace code. */
export async function reportStartupFailure(
  error: unknown,
  token: string,
  request: (request: Request) => Promise<Response> = fetch,
  native?: { exitCode: number | null },
) {
  if (process.env[startupDiagnosticEnv] !== "true" || !validControlToken(token)) return
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve()
    }, 2000)
  })
  const send = async () => {
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined
    const phase = native
      ? "native_runtime"
      : error instanceof CloudStartup.StartupError
        ? (error.phase ?? "supervisor")
        : "supervisor"
    const [overlay, workspaceMount] = await Promise.all([
      statfs("/workspace").then(
        (value) => value.type === 0x794c7630,
        () => null,
      ),
      isWorkspaceMount(),
    ])
    if (controller.signal.aborted) return
    const body = parseStartupDiagnostic({
      phase,
      code: startupDiagnosticCodes.find((value) => value === code) ?? "unknown",
      overlay,
      workspaceMount,
      exitCode: native?.exitCode ?? null,
    })
    if (!body) return
    const response = await request(
      new Request(`http://checkpoint.mongolgpt.internal${startupDiagnosticPath}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", [checkpointControlHeader]: token },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )
    void response.body?.cancel().catch(() => {})
  }
  try {
    await Promise.race([send().catch(() => {}), deadline])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function isWorkspaceMount(): Promise<boolean | null> {
  try {
    const file = await open("/proc/self/mountinfo", "r")
    try {
      const buffer = Buffer.alloc(65_537)
      let length = 0
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length === buffer.length) return null
      return buffer
        .subarray(0, length)
        .toString("utf8")
        .split("\n")
        .some((line) => line.split(" ")[4] === "/workspace")
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}
