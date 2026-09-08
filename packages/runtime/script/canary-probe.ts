import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { validControlToken } from "@mongolgpt/runtime-auth/control"

const scope = { accountID: "account_cloudflare_canary", workspaceID: "wrk_cloudflare_canary" }
const appOrigin = "https://canary.invalid"
const sessionID = "ses_cloudflare_canary_restore"
const proof = "mongolgpt-cloudflare-native-restore"

type State = {
  bootCount: number
  lastStop: { exitCode: number; reason: string } | null
  state: { status: string; exitCode?: number }
  epoch: number
  checkpointID: string | null
  revisionID: string | null
  revisionSequence: number | null
}

/** Run only against a fresh, separately provisioned canary Worker. No provider calls. */
export async function runCanaryProbe(input: {
  origin: string
  adminToken: string
  authSecret: string
  version: string
  request?: (url: string, init?: RequestInit) => Promise<Response>
  pause?: (ms: number) => Promise<void>
  signal?: AbortSignal
}) {
  check(
    /^https:\/\/mgpt-canary-[0-9]{1,12}-[0-9]{1,3}\.[a-z0-9-]+\.workers\.dev$/.test(input.origin),
    "Canary probe requires its isolated workers.dev origin",
  )
  check(validControlToken(input.adminToken) && input.authSecret.length >= 32, "Canary credentials are missing")
  const request = input.request ?? fetch
  const deadline = input.signal ?? AbortSignal.timeout(600_000)
  deadline.throwIfAborted()
  const pause = input.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const unauthenticated = await request(`${input.origin}/api/session`, {
    redirect: "error",
    signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]),
  })
  check(unauthenticated.status === 403, "Canary control gate admitted an anonymous caller")
  await unauthenticated.body?.cancel()
  const unauthorized = await request(`${input.origin}/api/session`, {
    headers: { "x-mongolgpt-canary-token": input.adminToken, origin: appOrigin },
    redirect: "error",
    signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]),
  })
  check(unauthorized.status === 401, "Production runtime authentication was bypassed")
  await unauthorized.body?.cancel()
  const health = await json<{ healthy: boolean; version: string; stage: string }>("/global/health", false)
  check(health.healthy && health.version === input.version && health.stage === "dev", "Canary build identity mismatch")

  // A read starts the native runtime without retrying a possibly committed POST.
  const sessions = await ready()
  check(Array.isArray(sessions.data), "Native runtime did not return a session list")
  const created = await json<{ data: { id: string } }>("/api/session", true, {
    id: sessionID,
    location: { directory: "/workspace" },
  })
  check(created.data?.id === sessionID, "Native session was not created")
  await pty(
    `set -eu
test "$(id -u)" = 10001
test -z "\${MONGOLGPT_SDK_CONTROL_TOKEN:-}"
test -z "\${MONGOLGPT_CHECKPOINT_CONTROL_TOKEN:-}"
test -z "\${MONGOLGPT_RUNTIME_SECRET:-}"
test -z "\${MONGOLGPT_RUNTIME_AUTH_SECRET:-}"
test -z "\${CLOUDFLARE_API_TOKEN:-}"
test "$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/execute -H 'content-type: application/json' -d '{}')" = 403
test "$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' -X POST http://checkpoint.mongolgpt.internal/v1/bootstrap -d '{}')" = 403
grep -q mongolgpt-init /proc/1/cmdline
test ! -e /tmp/mgpt-canary-ephemeral
printf '%s' temporary > /tmp/mgpt-canary-ephemeral
mkdir -p /workspace/audit-proof
printf '%s' '${proof}' > /workspace/audit-proof/proof.txt
cat /proc/sys/kernel/random/boot_id > /workspace/audit-proof/boot-id.txt`,
  )
  await restored()
  const first = await state()
  check(first.bootCount >= 1 && !!first.checkpointID && !!first.revisionID, "Initial durable receipt is missing")
  const stopped = await stop(first)

  // Cloudflare must replace ephemeral disk, then restore from actual D1/R2.
  await restored()
  await pty(
    `set -eu
test "$(id -u)" = 10001
test ! -e /tmp/mgpt-canary-ephemeral
test "$(cat /proc/sys/kernel/random/boot_id)" != "$(cat /workspace/audit-proof/boot-id.txt)"
grep -q mongolgpt-init /proc/1/cmdline`,
  )
  const second = await state()
  check(second.bootCount === first.bootCount + 1, "Canary did not perform exactly one new container boot")
  check(second.epoch === first.epoch + 1, "Replacement did not acquire the next writer epoch")
  check(second.checkpointID === first.checkpointID, "Replacement discarded the original baseline")
  check((second.revisionSequence ?? 0) >= (stopped.revisionSequence ?? 0), "Replacement lost the shutdown revision")
  const final = await stop(second)
  return {
    ok: true,
    version: input.version,
    boots: [first.bootCount, second.bootCount],
    epoch: final.epoch,
    revisionSequence: final.revisionSequence,
    realPTY: true,
    privilegedEndpointsDenied: true,
    tiniEntrypoint: true,
    distinctVirtualMachineBoot: true,
    ephemeralDiskReplaced: true,
    sessionRestored: true,
    fileRestored: true,
    gracefulExit: true,
  }

  async function state() {
    return json<State>("/__canary/state", false)
  }

  async function ready() {
    const startup = AbortSignal.any([deadline, AbortSignal.timeout(300_000)])
    for (let attempt = 0; attempt < 60; attempt++) {
      startup.throwIfAborted()
      try {
        return await json<{ data: unknown[] }>("/api/session?location[directory]=/workspace", true, undefined, startup)
      } catch (error) {
        if (!(error instanceof CanaryRequestFailure) || !error.retryable || attempt === 59 || startup.aborted)
          throw error
        await pause(5000)
      }
    }
    throw new Error("Initial Cloudflare provisioning exceeded its deadline")
  }

  async function stop(before: State) {
    await json("/__canary/stop", false, null)
    let after = await state()
    for (let attempt = 0; !["stopped", "stopped_with_code"].includes(after.state.status) && attempt < 130; attempt++) {
      await pause(2000)
      after = await state()
    }
    check(["stopped", "stopped_with_code"].includes(after.state.status), "Canary shutdown exceeded its deadline")
    check(after.lastStop?.exitCode === 0, "Tini/native shutdown did not exit successfully")
    check(after.bootCount === before.bootCount, "Container restarted during shutdown verification")
    check(
      (after.revisionSequence ?? 0) > (before.revisionSequence ?? 0),
      "Shutdown did not durably publish native state",
    )
    return after
  }

  async function restored() {
    const session = await json<{ data: { id: string } }>(`/api/session/${sessionID}`, true)
    check(session.data?.id === sessionID, "Native session did not survive container replacement")
    const file = await json<{ type: string; content: string }>(
      "/file/content?path=audit-proof/proof.txt&directory=/workspace",
      true,
    )
    check(file.type === "text" && file.content === proof, "Native file did not survive container replacement")
  }

  async function pty(command: string) {
    const created = await json<{ data: { id: string } }>("/api/pty?location[directory]=/workspace", true, {
      command: "/bin/sh",
      args: ["-c", command],
      cwd: "/workspace",
      title: "Cloudflare canary",
    })
    check(/^pty[A-Za-z0-9_-]+$/.test(created.data?.id), "Native PTY was not created")
    for (let attempt = 0; attempt < 45; attempt++) {
      const result = await json<{ data: { status: string; exitCode?: number } }>(
        `/api/pty/${created.data.id}?location[directory]=/workspace`,
        true,
      )
      if (result.data?.status === "exited") {
        check(result.data.exitCode === 0, "Native PTY isolation or restored filesystem assertion failed")
        return
      }
      await pause(2000)
    }
    throw new Error("Native PTY did not exit before its deadline")
  }

  async function json<T = unknown>(path: string, native: boolean, body?: unknown, phase = deadline): Promise<T> {
    deadline.throwIfAborted()
    const headers = new Headers({ "x-mongolgpt-canary-token": input.adminToken, origin: appOrigin })
    if (native)
      headers.set(
        "authorization",
        `Bearer ${await issueRuntimeCapability({ ...scope, authVersion: 1, audience: input.origin, secret: input.authSecret, ttlSeconds: 120 })}`,
      )
    if (body !== undefined && body !== null) headers.set("content-type", "application/json")
    const response = await request(`${input.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([deadline, phase, AbortSignal.timeout(native ? 125_000 : 30_000)]),
    }).catch(() => {
      throw new CanaryRequestFailure("Canary request failed; credentials and response content are suppressed", true)
    })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new CanaryRequestFailure(
        `Canary endpoint failed: ${path.split("?")[0]} (HTTP ${response.status})`,
        [502, 503, 504, 520, 522, 523, 524].includes(response.status),
      )
    }
    return readCanaryJson<T>(response)
  }
}

export async function readCanaryJson<T = unknown>(response: Response): Promise<T> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel()
    throw new Error(`Canary response is not successful JSON (HTTP ${response.status})`)
  }
  const reader = response.body?.getReader()
  check(reader, "Canary returned an empty response")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      check(size <= 65_536, "Canary response exceeded its bounded size")
      chunks.push(item.value)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    return JSON.parse(text) as T
  } catch {
    throw new Error("Canary response could not be decoded safely")
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

class CanaryRequestFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
