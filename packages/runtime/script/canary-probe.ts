import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { validControlToken } from "@mongolgpt/runtime-auth/control"
import { parseRuntimeReadiness, sanitizeRuntimeDiagnostic } from "../src/runtime"

export type CanaryProbePhase =
  | "authorization"
  | "initial_startup"
  | "session_create"
  | "initial_pty"
  | "initial_readback"
  | "initial_shutdown"
  | "replacement_readback"
  | "replacement_pty"
  | "replacement_receipts"
  | "replacement_shutdown"
  | "complete"

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
  onPhase?: (phase: CanaryProbePhase) => void | Promise<void>
}) {
  check(
    /^https:\/\/mgpt-canary-[0-9]{1,12}-[0-9]{1,3}\.[a-z0-9-]+\.workers\.dev$/.test(input.origin),
    "Canary probe requires its isolated workers.dev origin",
  )
  check(validControlToken(input.adminToken) && input.authSecret.length >= 32, "Canary credentials are missing")
  const request = input.request ?? fetch
  const deadline = input.signal ?? AbortSignal.timeout(600_000)
  check(!deadline.aborted, "Canary probe deadline exceeded")
  const pause = input.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  await input.onPhase?.("authorization")
  await anonymousGate()
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
  await input.onPhase?.("initial_startup")
  const sessions = await ready()
  check(Array.isArray(sessions.data), "Native runtime did not return a session list")
  await input.onPhase?.("session_create")
  const created = await json<{ data: { id: string } }>("/api/session", true, {
    id: sessionID,
    location: { directory: "/workspace" },
  })
  check(created.data?.id === sessionID, "Native session was not created")
  await input.onPhase?.("initial_pty")
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
  await input.onPhase?.("initial_readback")
  await restored()
  const first = await state()
  check(first.bootCount >= 1 && !!first.checkpointID && !!first.revisionID, "Initial durable receipt is missing")
  await input.onPhase?.("initial_shutdown")
  const stopped = await stop(first)

  // Cloudflare must replace ephemeral disk, then restore from actual D1/R2.
  await input.onPhase?.("replacement_readback")
  await restored()
  await input.onPhase?.("replacement_pty")
  await pty(
    `set -eu
test "$(id -u)" = 10001
test ! -e /tmp/mgpt-canary-ephemeral
test "$(cat /proc/sys/kernel/random/boot_id)" != "$(cat /workspace/audit-proof/boot-id.txt)"
grep -q mongolgpt-init /proc/1/cmdline`,
  )
  await input.onPhase?.("replacement_receipts")
  const second = await state()
  // The pinned SDK calls onStart for warm port checks too. Physical replacement
  // is proved above by the kernel boot ID and below by exactly one new epoch.
  check(second.bootCount > first.bootCount, "Replacement did not invoke the SDK start callback")
  check(second.epoch === first.epoch + 1, "Replacement did not acquire the next writer epoch")
  check(second.checkpointID === first.checkpointID, "Replacement discarded the original baseline")
  check((second.revisionSequence ?? 0) >= (stopped.revisionSequence ?? 0), "Replacement lost the shutdown revision")
  await input.onPhase?.("replacement_shutdown")
  const final = await stop(second)
  await input.onPhase?.("complete")
  return {
    ok: true,
    version: input.version,
    startCallbacks: [first.bootCount, second.bootCount],
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

  async function anonymousGate() {
    const propagation = AbortSignal.any([deadline, AbortSignal.timeout(120_000)])
    let lastFailure = "no response"
    for (let attempt = 0; attempt < 24; attempt++) {
      if (propagation.aborted)
        throw new Error(`Canary control gate propagation exhausted its deadline; last result: ${lastFailure}`)
      try {
        const signal = AbortSignal.any([propagation, AbortSignal.timeout(30_000)])
        const response = await request(`${input.origin}/api/session`, {
          method: "GET",
          redirect: "error",
          signal,
        }).catch(() => {
          throw new CanaryRequestFailure(
            "Canary control gate network failure; private diagnostics are suppressed",
            true,
          )
        })
        if (response.status !== 403) {
          void response.body?.cancel().catch(() => {})
          throw new CanaryRequestFailure(
            `Canary control gate returned unexpected HTTP ${response.status}`,
            [404, 502, 503, 504, 520, 522, 523, 524].includes(response.status),
          )
        }
        try {
          check(response.headers.get("content-type")?.includes("application/json"), "Expected JSON")
          const body = await readCanaryJsonBody<unknown>(response, signal)
          check(
            body !== null &&
              typeof body === "object" &&
              !Array.isArray(body) &&
              (body as { error?: unknown }).error === "forbidden",
            "Expected canary forbidden receipt",
          )
        } catch {
          void response.body?.cancel().catch(() => {})
          throw new CanaryRequestFailure("Canary control gate returned invalid forbidden JSON (HTTP 403)", false)
        }
        return
      } catch (error) {
        if (!(error instanceof CanaryRequestFailure) || !error.retryable) throw error
        lastFailure = error.message
        if (attempt === 23 || propagation.aborted)
          throw new Error(`Canary control gate propagation exhausted; last result: ${lastFailure}`)
        await pause(5000)
      }
    }
  }

  async function ready() {
    const startup = AbortSignal.any([deadline, AbortSignal.timeout(300_000)])
    const diagnostic = { attempts: 0, lastFailure: "no response", lastResponse: "no HTTP response" }
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startup.aborted) throw exhausted("deadline exceeded")
      diagnostic.attempts++
      try {
        return await json<{ data: unknown[] }>("/api/session?location[directory]=/workspace", true, undefined, startup)
      } catch (error) {
        if (error instanceof CanaryRequestFailure) {
          diagnostic.lastFailure = error.message
          if (error.httpStatus !== undefined) diagnostic.lastResponse = error.message
          // A newly deployed origin can still return 404 after its control gate.
          // Only this initial GET may wait; POSTs and restoration reads never retry.
          if (!error.retryable && error.httpStatus !== 404) throw error
        }
        if (startup.aborted) throw exhausted("deadline exceeded")
        if (!(error instanceof CanaryRequestFailure)) throw error
        if (attempt === 59) throw exhausted("attempt limit exceeded")
        await pause(5000)
      }
    }
    throw exhausted("attempt limit exceeded")

    function exhausted(reason: "deadline exceeded" | "attempt limit exceeded") {
      // These fields contain only locally generated messages and allowlisted response details.
      return new Error(
        `Native startup ${reason} after ${diagnostic.attempts} attempts; last failure: ${diagnostic.lastFailure}; last HTTP response: ${diagnostic.lastResponse}`,
      )
    }
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
    check(after.epoch === before.epoch, "Writer epoch changed during shutdown verification")
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
      const detail = response.headers.get("content-type")?.includes("application/json")
        ? await readCanaryJsonBody<unknown>(response, AbortSignal.any([deadline, AbortSignal.timeout(5_000)]))
            .then(canaryFailureDiagnostic)
            .catch(() => "")
        : ""
      void response.body?.cancel().catch(() => {})
      throw new CanaryRequestFailure(
        `Canary endpoint failed: ${path.split("?")[0]} (HTTP ${response.status})${detail}`,
        [502, 503, 504, 520, 522, 523, 524].includes(response.status),
        response.status,
      )
    }
    return readCanaryJson<T>(response)
  }
}

function canaryFailureDiagnostic(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const body = value as { code?: unknown; diagnostic?: { code?: unknown }; readiness?: unknown }
  const codes = [
    "runtime_process_lookup_failed",
    "runtime_process_start_failed",
    "runtime_process_exited",
    "runtime_process_status_failed",
    "runtime_process_port_timeout",
    "runtime_proxy_failed",
    "runtime_websocket_proxy_failed",
    "runtime_unavailable",
  ]
  const code = typeof body.code === "string" && codes.includes(body.code) ? body.code : undefined
  // Reuse the production allowlist; never print messages, stack traces, or raw bodies.
  const diagnostic = sanitizeRuntimeDiagnostic({ code: body.diagnostic?.code, context: body.diagnostic })
  const readiness = parseRuntimeReadiness(body.readiness)
  return code || diagnostic || readiness ? ` ${JSON.stringify({ code, diagnostic, readiness })}` : ""
}

export async function readCanaryJson<T = unknown>(response: Response, signal?: AbortSignal): Promise<T> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Canary response is not successful JSON (HTTP ${response.status})`)
  }
  return readCanaryJsonBody<T>(response, signal)
}

async function readCanaryJsonBody<T>(response: Response, signal?: AbortSignal): Promise<T> {
  const reader = response.body?.getReader()
  check(reader, "Canary returned an empty response")
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      check(!signal?.aborted, "Canary response deadline exceeded")
      const item = await reader.read()
      check(!signal?.aborted, "Canary response deadline exceeded")
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
    signal?.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

class CanaryRequestFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message)
  }
}
