import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import type { Unstable_DevWorker } from "wrangler"
import { candidateProbeLocalOptions } from "./candidate-service-probe.ts"

export async function probeNativeSession(input: {
  request: (
    method: "GET" | "POST",
    signal: AbortSignal,
  ) => Promise<Response | Awaited<ReturnType<Unstable_DevWorker["fetch"]>>>
  sessionID: string
  expiresAt?: number
  observe?: (phase: string, status?: number) => void
  signal?: AbortSignal
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const expiresAt = input.expiresAt ?? now() + 100_000
  if (expiresAt - now() < 45_000) throw new Error("Candidate capability budget is insufficient")
  const deadline = AbortSignal.any([
    AbortSignal.timeout(expiresAt - now() - 5_000),
    ...(input.signal ? [input.signal] : []),
  ])
  const before = await json("GET", "native_read")
  if (!before || !Array.isArray(before.data) || before.data.length !== 0)
    throw new Error("Candidate synthetic scope is not empty")
  if (deadline.aborted || expiresAt - now() < 35_000)
    throw new Error("Candidate capability budget is insufficient for creation")
  const created = await json("POST", "session_create")
  if (!created || created.data?.id !== input.sessionID) throw new Error("Candidate session creation failed")
  const after = await json("GET", "session_readback")
  if (!after || !Array.isArray(after.data) || after.data.length !== 1 || after.data[0]?.id !== input.sessionID)
    throw new Error("Candidate session readback failed")
  return { nativeRead: true, sessionCreated: true, sessionReadback: true, nativeSessionOnly: true }

  async function json(method: "GET" | "POST", phase: string) {
    input.observe?.(phase)
    // Never retry POST, including after a timeout or ambiguous response.
    const signal = AbortSignal.any([
      deadline,
      AbortSignal.timeout(phase === "native_read" ? 60_000 : phase === "session_create" ? 20_000 : 10_000),
    ])
    const response = await input.request(method, signal)
    input.observe?.(phase, response.status)
    const reader = response.body?.getReader()
    try {
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json") || !reader)
        throw new Error("Candidate native HTTP contract failed")
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 65536 || signal.aborted) throw new Error("Candidate native response exceeded its budget")
        chunks.push(next.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally {
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
  }
}

async function main() {
  const configPath = process.argv[2]
  const reportPath = process.argv[3]
  if (process.argv.length !== 4 || !isAbsolute(configPath) || !isAbsolute(reportPath))
    throw new Error("Native probe paths are invalid")
  let phase = "proxy_setup"
  let status: number | undefined
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"))
    const { unstable_dev } = await import("wrangler")
    const platform = await unstable_dev(fileURLToPath(new URL("./candidate-native-bridge.ts", import.meta.url)), {
      config: configPath,
      ...candidateProbeLocalOptions,
    })
    const result = await probeNativeSession({
      sessionID: config.vars.PROBE_SESSION,
      expiresAt: config.vars.PROBE_EXPIRES_AT,
      request: async (method, signal) => {
        const response = await platform.fetch("/api/session", {
          method,
          headers: { "x-probe-key": config.vars.PROBE_KEY },
          redirect: "error",
          signal,
        })
        return response
      },
      observe: (value, code) => {
        phase = value
        status = code
      },
    }).finally(() => platform.stop())
    await writeFile(reportPath, JSON.stringify(result), { mode: 0o600, flag: "wx" })
  } catch {
    // Deliberately omit response bodies, configuration, cookies, tokens, and exception messages.
    await writeFile(reportPath, JSON.stringify({ phase, status }), { mode: 0o600 })
    throw new Error("Private native probe failed")
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Private native probe failed")
    process.exitCode = 1
  })
