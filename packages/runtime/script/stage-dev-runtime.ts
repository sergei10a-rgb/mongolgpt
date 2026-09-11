import { createHash } from "node:crypto"
import { chmod, mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json"
import packageJSON from "../package.json"
import { verifySandboxBuild } from "./build-sandbox"
import { storageMigrationCommand, verifyStorageIdentity, verifyStorageMigrations } from "./prepare-storage"

const root = fileURLToPath(new URL("..", import.meta.url))
const maxResponseBytes = 65_536
type Requester = (url: string, init: RequestInit) => Promise<Response>

export function candidateStagingContext(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.RUNNER_OS !== "Linux" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.MONGOLGPT_CANDIDATE_CONFIRMATION !== "STAGE DEV RUNTIME CANDIDATE" ||
    env.CLOUDFLARE_ACCOUNT_ID !== candidate.account_id ||
    !env.CLOUDFLARE_API_TOKEN?.trim() ||
    !isAbsolute(env.RUNNER_TEMP ?? "") ||
    candidate.vars.MONGOLGPT_RUNTIME_VERSION !== packageJSON.version
  )
    throw new Error("Candidate staging context is invalid")
  return {
    worker: candidate.name,
    accountID: candidate.account_id,
    sourceCommit: env.GITHUB_SHA!,
    output: join(env.RUNNER_TEMP!, "runtime-candidate-receipt.json"),
  }
}

export function candidateStagingSecrets(env: NodeJS.ProcessEnv) {
  const secrets = Object.fromEntries(
    candidate.secrets.required.map((name) => {
      const value = env[name]
      if (!value || value !== value.trim() || value.length < 32 || value.length > 8192 || /[\r\n\0]/.test(value))
        throw new Error("Candidate secret is missing or invalid")
      return [name, value]
    }),
  )
  if (secrets.MONGOLGPT_RUNTIME_SECRET === secrets.MONGOLGPT_RUNTIME_AUTH_SECRET)
    throw new Error("Candidate control secrets must be distinct")
  const keys: unknown = JSON.parse(secrets.MONGOLGPT_RUNTIME_BACKUP_KEYS)
  if (!record(keys) || Object.keys(keys).length > 8 || !Object.hasOwn(keys, "dev_20260912_v1"))
    throw new Error("Candidate requires the provisioned dev backup master")
  for (const [name, value] of Object.entries(keys)) {
    if (!/^dev_\d{8}_v[1-9]\d*$/.test(name) || typeof value !== "string") throw new Error("Invalid dev backup key")
    const bytes = Buffer.from(value, "base64")
    try {
      if (bytes.byteLength !== 32 || bytes.toString("base64") !== value) throw new Error("Invalid dev backup key")
    } finally {
      bytes.fill(0)
    }
  }
  return secrets
}

export function candidateStagingCommand(secretPath: string, node: string) {
  if (!isAbsolute(secretPath) || !isAbsolute(node)) throw new Error("Candidate command requires absolute paths")
  return [
    node,
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    `--config=${join(root, "wrangler.candidate.dev.json")}`,
    `--secrets-file=${secretPath}`,
  ]
}

export async function candidateMetadata(
  token: string,
  endpoint: "settings" | "subdomain" | "routes" | "domains",
  request: Requester = fetch,
) {
  // Cloudflare calls an un-nested Worker's API environment "production", even for our isolated dev Worker.
  const paths = {
    settings: `workers/scripts/${candidate.name}/settings`,
    subdomain: `workers/scripts/${candidate.name}/subdomain`,
    routes: `workers/services/${candidate.name}/environments/production/routes?show_zonename=true`,
    domains: `workers/domains/records?page=0&per_page=5&service=${candidate.name}&environment=production`,
  }
  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${candidate.account_id}/${paths[endpoint]}`,
    { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) },
  )
  if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error("Candidate metadata response is invalid")
  }
  const value: unknown = JSON.parse(await boundedText(response.body, maxResponseBytes))
  return { status: response.status, value }
}

export function assertCandidateAbsent(result: Awaited<ReturnType<typeof candidateMetadata>>) {
  if (
    result.status !== 404 ||
    !record(result.value) ||
    result.value.success !== false ||
    !Array.isArray(result.value.errors) ||
    result.value.errors.length !== 1 ||
    !record(result.value.errors[0]) ||
    result.value.errors[0].code !== 10007
  )
    throw new Error("Candidate already exists or its absence is unverified; do not repeat staging")
}

export function verifyCandidateRoutes(
  routes: Awaited<ReturnType<typeof candidateMetadata>>,
  domains: Awaited<ReturnType<typeof candidateMetadata>>,
) {
  for (const response of [routes, domains]) {
    if (
      response.status !== 200 ||
      !record(response.value) ||
      response.value.success !== true ||
      !Array.isArray(response.value.result) ||
      response.value.result.length !== 0
    )
      throw new Error("Candidate public routes or custom domains are present or unverified")
    const info = response.value.result_info
    if (info != null && (!record(info) || (info.total_count != null && info.total_count !== 0)))
      throw new Error("Candidate route pagination is inconsistent")
  }
}

export function verifyCandidateDeployment(
  settings: Awaited<ReturnType<typeof candidateMetadata>>,
  subdomain: Awaited<ReturnType<typeof candidateMetadata>>,
) {
  const value = settings.value
  const ingress = subdomain.value
  if (
    settings.status !== 200 ||
    !record(value) ||
    value.success !== true ||
    !record(value.result) ||
    !Array.isArray(value.result.bindings) ||
    !value.result.bindings.every(record) ||
    subdomain.status !== 200 ||
    !record(ingress) ||
    ingress.success !== true ||
    !record(ingress.result) ||
    ingress.result.enabled !== false ||
    ingress.result.previews_enabled !== false
  )
    throw new Error("Candidate settings or private ingress could not be verified")
  const bindings = value.result.bindings
  const binding = (name: string, type: string) => {
    const matches = bindings.filter((item) => item.name === name)
    if (matches.length !== 1 || matches[0].type !== type) throw new Error("Candidate binding mismatch")
    return matches[0]
  }
  if (
    binding("HISTORY", "d1").id !== candidate.d1_databases[0].database_id ||
    binding("RUNTIME_BACKUPS", "r2_bucket").bucket_name !== candidate.r2_buckets[0].bucket_name
  )
    throw new Error("Candidate storage mismatch")
  const sandbox = binding("Sandbox", "durable_object_namespace")
  if (
    typeof sandbox.namespace_id !== "string" ||
    !/^[a-f0-9]{32}$/.test(sandbox.namespace_id) ||
    sandbox.namespace_id === "ceb126c25207461582b78289fb6bc9d3" ||
    sandbox.class_name !== "MongolGPTSandbox" ||
    (sandbox.script_name != null && sandbox.script_name !== candidate.name)
  )
    throw new Error("Candidate namespace is not isolated")
  for (const name of candidate.secrets.required) binding(name, "secret_text")
  for (const [name, text] of Object.entries(candidate.vars)) {
    if (binding(name, "plain_text").text !== text) throw new Error("Candidate variable mismatch")
  }
  for (const expected of candidate.ratelimits) {
    const actual = binding(expected.name, "ratelimit")
    if (
      String(actual.namespace_id) !== expected.namespace_id ||
      !record(actual.simple) ||
      actual.simple.limit !== expected.simple.limit ||
      actual.simple.period !== expected.simple.period
    )
      throw new Error("Candidate rate limit mismatch")
  }
  if (bindings.some((item) => item.type === "service")) throw new Error("Candidate must not bind other Workers")
  return { namespaceID: sandbox.namespace_id }
}

async function stage() {
  if (process.platform !== "linux" || process.argv.length !== 2) throw new Error("Candidate staging requires Linux CI")
  const identity = candidateStagingContext(process.env)
  const secrets = candidateStagingSecrets(process.env)
  const node = Bun.which("node")
  if (!node) throw new Error("Pinned Node runtime is missing")
  await verifySandboxBuild()
  const binary = join(root, "container/mongolgpt")
  if ((await runCandidateCommand([binary, "--version"], 10_000, false)).trim() !== packageJSON.version)
    throw new Error("Candidate binary version mismatch")
  const sha256 = createHash("sha256")
    .update(Buffer.from(await Bun.file(binary).arrayBuffer()))
    .digest("hex")
  console.log("CANDIDATE_PHASE storage_identity")
  await verifyStorageIdentity(process.env.CLOUDFLARE_API_TOKEN!)
  const expected = (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort()
  const migrations = verifyStorageMigrations(
    JSON.parse(await runCandidateCommand(storageMigrationCommand("verify"), 180_000)),
    expected,
  )
  assertCandidateAbsent(await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "settings"))
  const folder = await mkdtemp(join(process.env.RUNNER_TEMP!, "mongolgpt-candidate-"))
  await chmod(folder, 0o700)
  const secretPath = join(folder, "secrets.json")
  const receipt = {
    ...identity,
    version: packageJSON.version,
    binarySha256: sha256,
    migrations,
    deployment: "not_started",
    namespaceID: "",
    publicIngress: "unverified",
    cutoverReady: false,
  }
  try {
    await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600, flag: "wx" })
    receipt.deployment = "attempted"
    await save()
    console.log("CANDIDATE_PHASE deploy")
    await runCandidateCommand(candidateStagingCommand(secretPath, node), 900_000)
    console.log("CANDIDATE_PHASE verify")
    const verified = verifyCandidateDeployment(
      await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "settings"),
      await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "subdomain"),
    )
    verifyCandidateRoutes(
      await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "routes"),
      await candidateMetadata(process.env.CLOUDFLARE_API_TOKEN!, "domains"),
    )
    receipt.namespaceID = verified.namespaceID
    receipt.deployment = "verified"
    receipt.publicIngress = "disabled"
    await save()
    console.log("Candidate байршуулалт батлагдлаа. Нийтийн урсгал шилжүүлээгүй, хуучин runtime-ийг өөрчлөөгүй.")
  } finally {
    await rm(secretPath, { force: true })
    await rmdir(folder)
  }

  async function save() {
    await writeFile(identity.output, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  }
}

export async function runCandidateCommand(
  command: string[],
  timeout: number,
  authenticated = true,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (process.platform !== "linux") throw new Error("Candidate commands require Linux process groups")
  const child = Bun.spawn(command, {
    cwd: root,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      TMPDIR: env.RUNNER_TEMP,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      ...(authenticated
        ? { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: candidate.account_id }
        : {}),
    },
  })
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeout)
  try {
    const [output, , exit] = await Promise.all([
      boundedText(child.stdout, 2 * 1024 * 1024),
      boundedText(child.stderr, 2 * 1024 * 1024),
      child.exited,
    ])
    if (timedOut || exit !== 0) throw new Error("Candidate command failed; private command output was not logged")
    return output
  } finally {
    clearTimeout(timer)
    // A finished leader can still leave descendants holding output pipes open.
    stop()
    await child.exited
  }
}

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return Buffer.concat(chunks).toString("utf8")
      size += next.value.byteLength
      if (size > limit) throw new Error("Candidate response exceeded its bound")
      chunks.push(next.value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

if (import.meta.main)
  stage().catch(() => {
    console.error(
      "Candidate байршуулалт батлагдсангүй. Давтан байршуулалтаас өмнө receipt-ийг шалгана уу. Нууц утга хэвлээгүй.",
    )
    process.exitCode = 1
  })
