import {
  checkpointControlHeader,
  deriveCheckpointControlToken,
  matchesControlToken,
} from "@mongolgpt/runtime-auth/control"
import {
  parseStartupDiagnostic,
  startupDiagnosticPath,
  type StartupDiagnostic,
} from "@mongolgpt/runtime-auth/startup-diagnostic"
import { parseCanaryStartupFailure } from "../../script/canary-diagnostics"

type Storage = Pick<DurableObjectStorage, "get" | "put">
const startupFailureKey = "canary:startupFailure"

export async function persistCanaryStartup(storage: Storage, input: unknown) {
  const diagnostic = parseStartupDiagnostic(input)
  if (!diagnostic) throw new Error("Invalid startup diagnostic")
  const bootCount = (await storage.get("canary:bootCount")) ?? 0
  if (typeof bootCount !== "number" || !Number.isInteger(bootCount) || bootCount < 0 || bootCount > 2_147_483_647)
    throw new Error("Invalid startup boot count")
  await storage.put(startupFailureKey, { bootCount, diagnostic })
}

export async function readCanaryStartup(storage: Storage) {
  return parseCanaryStartupFailure(await storage.get(startupFailureKey)) ?? null
}

type Environment = {
  STAGE?: string
  CANARY_RUN_ID?: string
  CANARY_ADMIN_TOKEN?: string
  MONGOLGPT_RUNTIME_SECRET?: string
}

export function canaryStartupConfigured(env: Environment) {
  return (
    env.STAGE === "dev" &&
    /^mgpt-canary-[0-9]{1,12}-[0-9]{1,3}$/.test(env.CANARY_RUN_ID ?? "") &&
    /^[0-9a-f]{64}$/.test(env.CANARY_ADMIN_TOKEN ?? "")
  )
}

export async function collectCanaryStartup(
  request: Request,
  env: Environment,
  context: { params?: unknown },
  store: (value: StartupDiagnostic) => Promise<void>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const deadline = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      expired = true
      void reader?.cancel().catch(() => {})
      resolve(new Response(null, { status: 408 }))
    }, 1500)
  })
  const receive = async () => {
    const url = new URL(request.url)
    const scope = context.params as { accountID?: unknown; workspaceID?: unknown } | undefined
    if (
      !canaryStartupConfigured(env) ||
      scope?.accountID !== "account_cloudflare_canary" ||
      scope?.workspaceID !== "wrk_cloudflare_canary"
    )
      return new Response(null, { status: 403 })
    const expected = await deriveCheckpointControlToken(env.MONGOLGPT_RUNTIME_SECRET ?? "", {
      accountID: "account_cloudflare_canary",
      workspaceID: "wrk_cloudflare_canary",
    })
    if (!matchesControlToken(request.headers.get(checkpointControlHeader), expected))
      return new Response(null, { status: 403 })
    if (expired || request.signal.aborted) return new Response(null, { status: 408 })
    if (
      request.method !== "POST" ||
      url.href !== `http://checkpoint.mongolgpt.internal${startupDiagnosticPath}` ||
      request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" ||
      !request.body
    )
      return new Response(null, { status: 400 })
    const length = request.headers.get("content-length")
    if (length !== null && (!/^[0-9]{1,3}$/.test(length) || Number(length) > 512))
      return new Response(null, { status: 413 })
    reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (!expired && !request.signal.aborted) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 512) return new Response(null, { status: 413 })
      if (next.value.byteLength) chunks.push(next.value)
    }
    if (expired || request.signal.aborted) return new Response(null, { status: 408 })
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    const diagnostic = parseStartupDiagnostic(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)))
    if (!diagnostic) return new Response(null, { status: 400 })
    await store(diagnostic)
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
  }
  try {
    return await Promise.race([receive().catch(() => new Response(null, { status: 400 })), deadline])
  } finally {
    clearTimeout(timer)
    expired = true
    if (reader) void reader.cancel().catch(() => {})
    else void request.body?.cancel().catch(() => {})
  }
}
