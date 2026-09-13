import { writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json" with { type: "json" }

export async function probeCandidateService(request: (input: Request) => Promise<Response>) {
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
    const response = await request(
      new Request(`https://candidate.invalid${check.path}`, {
        method: "GET",
        headers: check.headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    )
    try {
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
        if (
          body?.healthy !== true ||
          body.service !== "mongolgpt-runtime" ||
          body.stage !== "dev" ||
          body.version !== candidate.vars.MONGOLGPT_RUNTIME_VERSION
        )
          throw new Error("Candidate health content failed")
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
  const { getPlatformProxy } = await import("wrangler")
  const platform = await getPlatformProxy<{ CANDIDATE: { fetch(input: Request): Promise<Response> } }>({
    configPath,
    persist: false,
    remoteBindings: true,
  })
  const result = await probeCandidateService((request) => platform.env.CANDIDATE.fetch(request)).finally(() =>
    platform.dispose(),
  )
  await writeFile(reportPath, JSON.stringify(result), { mode: 0o600, flag: "wx" })
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Private service probe failed")
    process.exitCode = 1
  })
