import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { RuntimeSupervisor } from "@mongolgpt/core/runtime-supervisor"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"
import { checkpointControlEnv } from "@mongolgpt/runtime-auth/control"
import { startupDiagnosticEnv } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { reportStartupFailure } from "../../src/cli/startup-diagnostic"
import { runRuntimeSupervisor } from "../../src/cli/runtime-supervisor"
import { nativeStartupDiagnostic } from "../../src/cli/native-startup-diagnostic"

if (process.argv.includes("--handoff-reject-probe")) {
  const error = await StartupHandoff.accept("/workspace").catch((error: unknown) => error)
  if (!(error instanceof StartupHandoff.HandoffError)) process.exit(99)
  const diagnostic = nativeStartupDiagnostic(error)
  if (!diagnostic) process.exit(98)
  process.stderr.write(diagnostic, () => process.exit(1))
  await new Promise(() => {})
}

if (process.argv.includes("--native-exit-probe")) {
  // Use real stderr with sensitive decoys; the persisted receipt may contain
  // only the allowlisted errno, not this message or inherited credentials.
  process.stderr.write("EACCES: private-test-user@example.test /private-test-path\n", () => process.exit(17))
  await new Promise(() => {})
}

const config = JSON.parse(await Bun.stdin.text()) as {
  origin: string
  token: string
  admin: string
  missingRoot: string
  nativeExit?: boolean
  nativeHandoff?: boolean
}
if (new URL(config.origin).hostname !== "127.0.0.1") throw new Error("Loopback test only")
process.env[startupDiagnosticEnv] = "true"
let reported = false
if (config.nativeExit || config.nativeHandoff) {
  Object.assign(process.env, {
    MONGOLGPT_RUNTIME_MODE: "hosted",
    MONGOLGPT_CLOUD_HISTORY: "true",
    MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
    MONGOLGPT_SERVER_PASSWORD: "local-diagnostic-test",
    [checkpointControlEnv]: config.token,
  })
  let completed = false
  const result = await runRuntimeSupervisor({
    // Only the container lifecycle is adapted. The compiled child, supervisor,
    // reporter, network transport, collector and durable storage are real.
    start: async (input) => {
      assert.equal(input.env[startupDiagnosticEnv], undefined)
      assert.equal(input.env[checkpointControlEnv], undefined)
      const packet = config.nativeHandoff
        ? await StartupHandoff.issue({
            root: "/workspace",
            group: `/sys/fs/cgroup/mongolgpt-${randomUUID()}`,
            checkpoint: null,
          })
        : undefined
      const child = spawn(process.execPath, [config.nativeHandoff ? "--handoff-reject-probe" : "--native-exit-probe"], {
        env: { ...input.env, ...(packet ? { MONGOLGPT_RUNTIME_PREPARED_FD: "4" } : {}) },
        windowsHide: true,
        ...(packet ? { uid: 10001, gid: 10001 } : {}),
        stdio: ["ignore", "ignore", input.stderr ?? "ignore", "ignore", packet?.fd ?? "ignore"],
      })
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
      await packet?.close()
      let finish!: () => void
      const control = new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        child,
        control,
        group: {
          close: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill()
            await closed
            finish()
          },
        },
        stop: async () => {
          throw new Error("An early child exit must not publish a checkpoint")
        },
      } as unknown as Awaited<ReturnType<typeof RuntimeSupervisor.start>>
    },
    connect: async () => ({
      complete: async (success) => {
        assert.equal(success, false)
        assert.equal(reported, true)
        completed = true
      },
    }),
    request,
  })
  assert.equal(result, config.nativeHandoff ? 1 : 17)
  assert.equal(completed, true)
  console.log(JSON.stringify({ reported, completed, exitCode: result }))
  process.exit(0)
}
const error = await CloudStartup.bootstrap({
  root: config.missingRoot,
  request: async () => {
    throw new Error("Missing root must fail before network")
  },
}).catch((error: unknown) => error)
if (!(error instanceof CloudStartup.StartupError) || error.phase !== "validate_root" || error.code !== "ENOENT")
  throw new Error("Expected actual missing-root startup failure")
await reportStartupFailure(error, config.token, request)
if (!reported) throw new Error("Startup failure not retained")
console.log(JSON.stringify({ reported: true, phase: error.phase, code: error.code }))

async function request(input: Request) {
  const url = new URL(input.url)
  if (url.origin !== "http://checkpoint.mongolgpt.internal" || url.pathname !== "/v1/startup-diagnostic")
    throw new Error("Unexpected diagnostic destination")
  const forwarded = new Request(`${config.origin}${url.pathname}`, input)
  forwarded.headers.set("x-test-admin-token", config.admin)
  const response = await fetch(forwarded)
  reported = response.status === 204
  return response
}
