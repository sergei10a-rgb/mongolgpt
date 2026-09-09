import type { Readable, Writable } from "node:stream"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"
import { RuntimeControl } from "@mongolgpt/core/runtime-control"
import { startupDiagnosticCodes, type StartupDiagnostic } from "@mongolgpt/runtime-auth/startup-diagnostic"

/** Root-only, canary-only observation. Child text is untrusted: retain at most
 * 4 KiB in memory and return only a fixed classification, never log contents. */
export function captureNativeStderr(stream: Readable | null, destination: Writable = process.stderr) {
  const bytes = Buffer.alloc(4096)
  let length = 0
  const capture = (chunk: Buffer) => {
    const count = Math.min(chunk.length, bytes.length - length)
    if (count > 0) length += chunk.copy(bytes, length, 0, count)
  }
  let finish!: () => void
  const closed = new Promise<void>((resolve) => {
    finish = resolve
  })
  stream?.on("data", capture)
  stream?.once("end", finish)
  stream?.once("close", finish)
  stream?.once("error", finish)
  stream?.pipe(destination, { end: false })
  let result: Promise<StartupDiagnostic["code"]> | undefined
  return () => (result ??= collect())

  async function collect(): Promise<StartupDiagnostic["code"]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (stream && !stream.readableEnded && !stream.destroyed)
        await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, 500)))])
      const text = bytes.subarray(0, length).toString("utf8")
      if (text.includes("MongolGPT workspace isolation failed.")) return "WorkspaceIsolationError"
      // CLI errorMessage intentionally prints only the message for these errors.
      if (text.includes(new StartupHandoff.HandoffError().message)) return "StartupHandoffError"
      if (text.includes(new RuntimeControl.RuntimeControlError().message)) return "RuntimeControlError"
      return (
        startupDiagnosticCodes.find(
          (code) => code !== "unknown" && new RegExp(`(^|[^A-Za-z0-9_])${code}([^A-Za-z0-9_]|$)`).test(text),
        ) ?? "unknown"
      )
    } finally {
      clearTimeout(timer)
      bytes.fill(0)
      stream?.unpipe(destination)
      stream?.removeListener("data", capture)
      stream?.removeListener("end", finish)
      stream?.removeListener("close", finish)
      stream?.removeListener("error", finish)
      // Only the diagnostic stderr pipe is ours; inherited stdout/stdin and
      // the supervisor's process/control cleanup retain their original owners.
      stream?.destroy()
    }
  }
}
