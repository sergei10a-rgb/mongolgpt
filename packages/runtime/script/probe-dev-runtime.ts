import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json"
import {
  candidateMetadata,
  runCandidateCommand,
  verifyCandidateDeployment,
  verifyCandidateRoutes,
} from "./stage-dev-runtime"

export function candidateProbeFailure(value: unknown) {
  if (!value || typeof value !== "object") return {}
  const result: Record<string, string | number | boolean> = {}
  if (
    "kind" in value &&
    ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(String(value.kind))
  )
    result.kind = String(value.kind)
  if (!("progress" in value) || !value.progress || typeof value.progress !== "object") return result
  const progress = value.progress
  if (
    !("check" in progress) ||
    !["health", "wrongOrigin", "anonymous", "invalidToken"].includes(String(progress.check))
  )
    return result
  result.check = String(progress.check)
  if (
    "status" in progress &&
    typeof progress.status === "number" &&
    Number.isInteger(progress.status) &&
    progress.status >= 100 &&
    progress.status < 600
  )
    result.status = progress.status
  if ("json" in progress && typeof progress.json === "boolean") result.json = progress.json
  if ("health" in progress && typeof progress.health === "boolean") result.health = progress.health
  return result
}

export function candidateProbeContext(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.RUNNER_OS !== "Linux" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.MONGOLGPT_CANDIDATE_CONFIRMATION !== "PROBE DEV RUNTIME CANDIDATE" ||
    env.CLOUDFLARE_ACCOUNT_ID !== candidate.account_id ||
    !env.CLOUDFLARE_API_TOKEN?.trim() ||
    !isAbsolute(env.RUNNER_TEMP ?? "")
  )
    throw new Error("Candidate probe context is invalid")
  return { worker: candidate.name, probeCommit: env.GITHUB_SHA }
}

export function candidateProbeConfig() {
  return {
    name: "mongolgpt-candidate-probe-dev",
    account_id: candidate.account_id,
    compatibility_date: candidate.compatibility_date,
    workers_dev: false,
    preview_urls: false,
    routes: [],
    services: [{ binding: "CANDIDATE", service: candidate.name, remote: true }],
  }
}

async function probe() {
  if (process.platform !== "linux" || process.argv.length !== 2) throw new Error("Candidate probe requires Linux CI")
  const identity = candidateProbeContext(process.env)
  const node = Bun.which("node")
  if (!node) throw new Error("Node runtime is missing")
  console.log("CANDIDATE_PROBE_PHASE metadata_before")
  const before = await verify()
  const folder = await mkdtemp(join(process.env.RUNNER_TEMP!, "mongolgpt-candidate-probe-"))
  await chmod(folder, 0o700)
  try {
    const configPath = join(folder, "wrangler.json")
    const reportPath = join(folder, "result.json")
    await writeFile(configPath, JSON.stringify(candidateProbeConfig()), { mode: 0o600, flag: "wx" })
    // A loopback-only local Worker invokes the remote service; it never deploys or exposes the candidate.
    console.log("CANDIDATE_PROBE_PHASE private_service")
    try {
      await runCandidateCommand(
        [node, fileURLToPath(new URL("./candidate-service-probe.ts", import.meta.url)), configPath, reportPath],
        180_000,
      )
    } catch {
      if (await Bun.file(reportPath).exists()) {
        const failure: unknown = await Bun.file(reportPath).json()
        console.log("CANDIDATE_PROBE_HTTP", JSON.stringify(candidateProbeFailure(failure)))
        if (failure && typeof failure === "object" && "failure" in failure) {
          const categories = ["proxy_setup", "http_contract", "proxy_cleanup", "module_load"]
          if (categories.includes(String(failure.failure))) console.log(`CANDIDATE_PROBE_FAILURE ${failure.failure}`)
          if ("code" in failure && typeof failure.code === "number" && Number.isSafeInteger(failure.code))
            console.log(`CANDIDATE_PROBE_API_CODE ${failure.code}`)
        }
      }
      throw new Error("Candidate service probe failed")
    }
    const result: unknown = await Bun.file(reportPath).json()
    if (JSON.stringify(result) !== JSON.stringify({ health: 200, wrongOrigin: 403, anonymous: 401, invalidToken: 401 }))
      throw new Error("Candidate probe receipt is invalid")
    console.log("CANDIDATE_PROBE_PHASE metadata_after")
    const after = await verify()
    if (before.namespaceID !== after.namespaceID) throw new Error("Candidate namespace changed during the probe")
    await writeFile(
      join(process.env.RUNNER_TEMP!, "runtime-candidate-probe.json"),
      JSON.stringify(
        { ...identity, ...after, checks: result, publicIngress: "disabled", cutoverReady: false },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    console.log(
      "Private candidate health and authentication-denial checks passed; no container or model call performed.",
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

async function verify() {
  const result = verifyCandidateDeployment(
    await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "settings"),
    await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "subdomain"),
  )
  verifyCandidateRoutes(
    await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "routes"),
    await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "domains"),
  )
  return result
}

if (import.meta.main)
  probe().catch((error: unknown) => {
    const known = [
      "Candidate probe context is invalid",
      "Candidate metadata response is invalid",
      "Candidate settings or private ingress could not be verified",
      "Candidate binding mismatch",
      "Candidate storage mismatch",
      "Candidate namespace is not isolated",
      "Candidate variable mismatch",
      "Candidate rate limit mismatch",
      "Candidate must not bind other Workers",
      "Candidate public routes or custom domains are present or unverified",
      "Candidate route pagination is inconsistent",
      "Candidate probe receipt is invalid",
      "Candidate namespace changed during the probe",
      "Candidate service probe failed",
    ]
    if (error instanceof Error && known.includes(error.message)) console.error(error.message)
    console.error("Private candidate probe failed; private command output was not logged. No promotion performed.")
    process.exitCode = 1
  })
