import { writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json" with { type: "json" }

type CandidateService = { fetch(input: string, init: RequestInit): Promise<Response> }

export function candidateServiceRequest(service: CandidateService, request: Request) {
  // Miniflare uses its own Request class and cannot accept Node's native Request instance.
  return service.fetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    redirect: request.redirect,
    signal: request.signal,
  })
}

export type ProbeProgress = { check: string; status?: number; json?: boolean; health?: boolean }

export async function probeCandidateService(
  request: (input: Request) => Promise<Response>,
  observe: (progress: ProbeProgress) => void = () => {},
) {
  const checks: { name: string; path: string; status: number; headers: Record<string, string> }[] = [
    { name: "health", path: "/global/health", status: 200, headers: {} },
    { name: "wrongOrigin", path: "/session", status: 403, headers: {} },
    { name: "anonymous", path: "/session", status: 401, headers: { origin: candidate.vars.MONGOLGPT_APP_ORIGIN } },
    {
      name: "invalidToken",
      path: "/session",
      status: 401,
      headers: { origin: candidate.vars.MONGOLGPT_APP_ORIGIN, authorization: "Bearer invalid" },
    },
  ]
  const result: Record<string, number> = {}
  for (const check of checks) {
    observe({ check: check.name })
    const response = await request(
      new Request(`https://candidate.invalid${check.path}`, {
        method: "GET",
        headers: check.headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    )
    try {
      observe({
        check: check.name,
        status: response.status,
        json: !!response.headers.get("content-type")?.startsWith("application/json"),
      })
      if (response.status !== check.status || !response.headers.get("content-type")?.startsWith("application/json"))
        throw new Error("Candidate HTTP contract failed")
      if (check.name === "health") {
        const reader = response.body?.getReader()
        if (!reader) throw new Error("Candidate health body is missing")
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > 4096) throw new Error("Candidate health body is too large")
            chunks.push(next.value)
          }
        } finally {
          await reader.cancel()
          reader.releaseLock()
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const healthy =
          body?.healthy === true &&
          body.service === "mongolgpt-runtime" &&
          body.stage === "dev" &&
          body.version === candidate.vars.MONGOLGPT_RUNTIME_VERSION
        observe({ check: check.name, status: response.status, json: true, health: healthy })
        if (!healthy) throw new Error("Candidate health content failed")
      }
      result[check.name] = response.status
    } finally {
      await response.body?.cancel().catch(() => {})
    }
  }
  return result
}

async function main() {
  const configPath = process.argv[2]
  const reportPath = process.argv[3]
  if (process.argv.length !== 4 || !isAbsolute(configPath) || !isAbsolute(reportPath))
    throw new Error("Private probe paths are invalid")
  let phase = "module_load"
  let progress: ProbeProgress | undefined
  try {
    const { getPlatformProxy } = await import("wrangler")
    phase = "proxy_setup"
    const platform = await getPlatformProxy<{ CANDIDATE: CandidateService }>({
      configPath,
      persist: false,
      remoteBindings: true,
    })
    phase = "http_contract"
    const result = await probeCandidateService(
      (request) => candidateServiceRequest(platform.env.CANDIDATE, request),
      (value) => {
        progress = value
      },
    ).finally(async () => {
      try {
        await platform.dispose()
      } catch (error) {
        phase = "proxy_cleanup"
        throw error
      }
    })
    await writeFile(reportPath, JSON.stringify(result), { mode: 0o600, flag: "wx" })
  } catch (error) {
    const kind =
      error instanceof Error && ["TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error.name)
        ? error.name
        : "Error"
    await writeFile(reportPath, JSON.stringify({ failure: phase, code: probeErrorCode(error), progress, kind }), {
      mode: 0o600,
    })
    throw new Error("Private probe failed")
  }
}

export function probeErrorCode(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== "object" || depth > 3) return
  if ("code" in error && typeof error.code === "number" && Number.isSafeInteger(error.code)) return error.code
  if ("cause" in error) return probeErrorCode(error.cause, depth + 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Private service probe failed")
    process.exitCode = 1
  })
