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
  const before = await verify()
  const folder = await mkdtemp(join(process.env.RUNNER_TEMP!, "mongolgpt-candidate-probe-"))
  await chmod(folder, 0o700)
  try {
    const configPath = join(folder, "wrangler.json")
    const reportPath = join(folder, "result.json")
    await writeFile(configPath, JSON.stringify(candidateProbeConfig()), { mode: 0o600, flag: "wx" })
    // Wrangler's Node-only proxy invokes a private service binding; it does not deploy or expose the candidate.
    await runCandidateCommand(
      [node, fileURLToPath(new URL("./candidate-service-probe.ts", import.meta.url)), configPath, reportPath],
      180_000,
    )
    const result: unknown = await Bun.file(reportPath).json()
    if (JSON.stringify(result) !== JSON.stringify({ health: 200, wrongOrigin: 403, anonymous: 401, invalidToken: 401 }))
      throw new Error("Candidate probe receipt is invalid")
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
  probe().catch(() => {
    console.error("Private candidate probe failed; private command output was not logged. No promotion performed.")
    process.exitCode = 1
  })
