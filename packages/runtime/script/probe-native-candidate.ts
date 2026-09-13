import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { candidateProbeConfig, candidateProbeContext, verify } from "./probe-dev-runtime"
import { runCandidateCommand } from "./stage-dev-runtime"

export function nativeProbeContext(env: NodeJS.ProcessEnv) {
  if (
    env.MONGOLGPT_CANDIDATE_CONFIRMATION !== "VERIFY DEV CANDIDATE SESSION" ||
    !/^[0-9]{1,12}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[0-9]{1,3}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    (env.MONGOLGPT_RUNTIME_AUTH_SECRET?.length ?? 0) < 32
  )
    throw new Error("Native candidate probe context is invalid")
  const identity = candidateProbeContext({ ...env, MONGOLGPT_CANDIDATE_CONFIRMATION: "PROBE DEV RUNTIME CANDIDATE" })
  const suffix = `${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}`
  return {
    ...identity,
    accountID: `account_candidate_${suffix}`,
    workspaceID: `wrk_candidate_${suffix}`,
    sessionID: `ses_candidate_${suffix}`,
  }
}

async function main() {
  if (process.platform !== "linux" || process.argv.length !== 2) throw new Error("Native probe requires Linux CI")
  const identity = nativeProbeContext(process.env)
  const before = await verify()
  const node = Bun.which("node")
  if (!node) throw new Error("Node runtime is missing")
  const folder = await mkdtemp(join(process.env.RUNNER_TEMP!, "mongolgpt-native-probe-"))
  await chmod(folder, 0o700)
  try {
    const configPath = join(folder, "wrangler.json")
    const reportPath = join(folder, "result.json")
    const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 120_000
    const token = await issueRuntimeCapability({
      accountID: identity.accountID,
      workspaceID: identity.workspaceID,
      authVersion: 1,
      audience: "https://candidate.invalid",
      secret: process.env.MONGOLGPT_RUNTIME_AUTH_SECRET!,
      ttlSeconds: 120,
    })
    await writeFile(
      configPath,
      JSON.stringify({
        ...candidateProbeConfig(),
        vars: {
          PROBE_KEY: crypto.randomUUID(),
          PROBE_TOKEN: token,
          PROBE_SESSION: identity.sessionID,
          PROBE_EXPIRES_AT: expiresAt,
        },
      }),
      { mode: 0o600, flag: "wx" },
    )
    try {
      // The signing secret is not inherited by Wrangler. Only this short-lived synthetic capability is supplied.
      await runCandidateCommand(
        [node, fileURLToPath(new URL("./candidate-native-service.ts", import.meta.url)), configPath, reportPath],
        150_000,
      )
    } catch {
      const failure = await Bun.file(reportPath)
        .json()
        .catch(() => ({}))
      if (["proxy_setup", "native_read", "session_create", "session_readback"].includes(failure.phase))
        console.log("CANDIDATE_NATIVE_PHASE", failure.phase)
      if (Number.isInteger(failure.status) && failure.status >= 100 && failure.status < 600)
        console.log("CANDIDATE_NATIVE_STATUS", failure.status)
      throw new Error("Native candidate probe failed")
    }
    const checks = await Bun.file(reportPath).json()
    if (
      JSON.stringify(checks) !==
      JSON.stringify({ nativeRead: true, sessionCreated: true, sessionReadback: true, nativeSessionOnly: true })
    )
      throw new Error("Native candidate receipt is invalid")
    const after = await verify()
    if (before.namespaceID !== after.namespaceID) throw new Error("Candidate namespace changed")
    await writeFile(
      join(process.env.RUNNER_TEMP!, "runtime-candidate-native.json"),
      JSON.stringify(
        {
          ...identity,
          ...after,
          checks,
          publicIngress: "disabled",
          syntheticIntegrationOnly: true,
          retainedSyntheticSession: true,
          browserOAuthVerified: false,
          cutoverReady: false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    console.log("Private native session created and read back. Synthetic integration only; no model call or promotion.")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

if (import.meta.main)
  main().catch(() => {
    console.error("Private native candidate verification failed. No promotion or automatic POST retry performed.")
    process.exitCode = 1
  })
