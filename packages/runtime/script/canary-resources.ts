import { join, resolve } from "node:path"

const cloudflareAPI = "https://api.cloudflare.com/client/v4"
const maxResponseBytes = 64 * 1024
const defaultTimeoutMs = 10_000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CanaryRequest = (input: string, init?: RequestInit) => Promise<Response>

export type CreateCanaryResourcesInput = {
  accountID: string
  token: string
  runID: string
  attempt: string
  request?: CanaryRequest
  onReceipt?: (receipt: Parameters<typeof cleanupCanaryResourceReceipt>[0]["receipt"]) => Promise<void>
}

export type CanaryCleanupInput = {
  request?: CanaryRequest
  purge?: () => Promise<void>
  workerDeployed?: boolean
  containerApplicationID?: string
}

export type CanaryCleanupResult = {
  name: string
  deleted: string[]
  skipped: string[]
  failures: Array<{ resource: string; message: string }>
  manualCleanup: string[]
}

export type CanaryResources = {
  name: string
  databaseID: string
  subdomain: string
  cleanup(input?: CanaryCleanupInput): Promise<CanaryCleanupResult>
}

export type CanaryConfigResources = {
  name: string
  databaseID: string
}

export type CanaryConfigInput = {
  resources: CanaryConfigResources
  accountID: string
  root: string
  version: string
}

export async function cleanupCanaryResourceReceipt(input: {
  accountID: string
  token: string
  receipt: {
    name: string
    databaseID?: string
    r2BucketCreated?: boolean
    workerDeployed?: boolean
    containerApplicationID?: string
  }
  purge?: () => Promise<void>
  request?: CanaryRequest
}) {
  const name = validateCanaryName(input.receipt.name)
  return cleanupCanaryResources({
    accountID: validateAccountID(input.accountID),
    token: validateToken(input.token),
    name,
    owned: {
      databaseID: input.receipt.databaseID ? validateDatabaseID(input.receipt.databaseID) : undefined,
      bucketName: input.receipt.r2BucketCreated === true ? name : undefined,
    },
    workerDeployed: input.receipt.workerDeployed,
    containerApplicationID: input.receipt.containerApplicationID,
    purge: input.purge,
    request: input.request ?? fetch,
  })
}

type OwnedResources = {
  databaseID?: string
  bucketName?: string
}

type CloudflareEnvelope<T> = {
  success?: boolean
  result?: T
  errors?: Array<{ code?: string | number; message?: string }>
}

type D1Database = {
  uuid?: unknown
  id?: unknown
  name?: unknown
}

type R2Bucket = {
  name?: unknown
}

type WorkerMetadata = {
  bindings?: unknown
}

type ContainerApplication = {
  id?: unknown
  name?: unknown
  durable_objects?: unknown
  durable_object?: unknown
  configuration?: unknown
}

export class CanaryResourceError extends Error {
  readonly cleanup?: CanaryCleanupResult
  readonly manualCleanup: string[]

  constructor(message: string, input: { cleanup?: CanaryCleanupResult; manualCleanup?: string[] } = {}) {
    super(message)
    this.name = "CanaryResourceError"
    this.cleanup = input.cleanup
    this.manualCleanup = input.manualCleanup ?? []
  }
}

export async function createCanaryResources(input: CreateCanaryResourcesInput): Promise<CanaryResources> {
  const accountID = validateAccountID(input.accountID)
  const token = validateToken(input.token)
  const name = createCanaryName(input.runID, input.attempt)
  const request = input.request ?? fetch
  const owned: OwnedResources = {}
  let uncertainCreate: string | undefined

  try {
    await preflightMissing(accountID, token, name, request)
    const subdomain = await getWorkersDevSubdomain(accountID, token, request)

    uncertainCreate = `d1:${name}:creation-status-uncertain`
    const database = await createD1Database(accountID, token, name, request)
    owned.databaseID = database.id
    uncertainCreate = undefined
    await input.onReceipt?.({ name, databaseID: database.id, r2BucketCreated: false, workerDeployed: false })

    uncertainCreate = `r2:${name}:creation-status-uncertain`
    const bucket = await createR2Bucket(accountID, token, name, request)
    owned.bucketName = bucket.name
    uncertainCreate = undefined
    await input.onReceipt?.({ name, databaseID: database.id, r2BucketCreated: true, workerDeployed: false })

    return {
      name,
      databaseID: database.id,
      subdomain,
      cleanup: (cleanupInput = {}) =>
        cleanupCanaryResources({
          accountID,
          token,
          name,
          owned,
          request: cleanupInput.request ?? request,
          purge: cleanupInput.purge,
          workerDeployed: cleanupInput.workerDeployed,
          containerApplicationID: cleanupInput.containerApplicationID,
        }),
    }
  } catch (error) {
    const cleanup = await cleanupCanaryResources({
      accountID,
      token,
      name,
      owned,
      request,
      workerDeployed: false,
    })
    throw new CanaryResourceError(safeThrownMessage(error), {
      cleanup,
      manualCleanup: uncertainCreate ? [uncertainCreate] : [],
    })
  }
}

export function createCanaryName(runID: string, attempt: string) {
  if (typeof runID !== "string" || !/^[0-9]{1,12}$/.test(runID)) {
    throw new TypeError("Canary runID must be 1..12 digits.")
  }
  if (typeof attempt !== "string" || !/^[0-9]{1,3}$/.test(attempt)) {
    throw new TypeError("Canary attempt must be 1..3 digits.")
  }
  return `mgpt-canary-${runID}-${attempt}`
}

export function createCanaryConfig(input: CanaryConfigInput) {
  const accountID = validateAccountID(input.accountID)
  const name = validateCanaryName(input.resources.name)
  const databaseID = validateDatabaseID(input.resources.databaseID)
  const version = input.version.trim()
  if (!version) throw new TypeError("Canary runtime version is required.")

  const root = resolve(input.root)
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name,
    main: join(root, "test", "fixtures", "cloudflare-canary.ts"),
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    account_id: accountID,
    secrets: {
      required: [
        "MONGOLGPT_RUNTIME_SECRET",
        "MONGOLGPT_RUNTIME_AUTH_SECRET",
        "MONGOLGPT_RUNTIME_BACKUP_KEYS",
        "CANARY_ADMIN_TOKEN",
      ],
    },
    vars: {
      STAGE: "dev",
      MONGOLGPT_CLOUD_HISTORY: "true",
      CANARY_RUN_ID: name,
      MONGOLGPT_APP_ORIGIN: "https://canary.invalid",
      MONGOLGPT_CONSOLE_URL: "https://canary.invalid",
      MONGOLGPT_RUNTIME_VERSION: version,
    },
    ratelimits: [
      {
        name: "MONGOLGPT_RUNTIME_BURST_LIMITER",
        namespace_id: canaryRateLimitNamespaceID(name, "burst"),
        simple: { limit: 60, period: 10 },
      },
      {
        name: "MONGOLGPT_RUNTIME_RATE_LIMITER",
        namespace_id: canaryRateLimitNamespaceID(name, "rate"),
        simple: { limit: 300, period: 60 },
      },
    ],
    d1_databases: [
      {
        binding: "HISTORY",
        database_name: name,
        database_id: databaseID,
        migrations_dir: join(root, "migrations"),
      },
    ],
    r2_buckets: [{ binding: "RUNTIME_BACKUPS", bucket_name: name }],
    containers: [
      {
        name,
        class_name: "CanarySandbox",
        image: join(root, "Dockerfile"),
        instance_type: "basic",
        max_instances: 1,
      },
    ],
    durable_objects: {
      bindings: [{ name: "Sandbox", class_name: "CanarySandbox" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CanarySandbox"] }],
  }
}

async function preflightMissing(accountID: string, token: string, name: string, request: CanaryRequest) {
  const worker = await optionalCloudflareResult<WorkerMetadata>(
    accountID,
    token,
    `/accounts/${accountID}/workers/scripts/${encodeURIComponent(name)}/settings`,
    request,
  )
  if (worker !== null) throw new CanaryResourceError(`Canary Worker already exists: ${name}`)

  const bucket = await optionalCloudflareResult<R2Bucket>(
    accountID,
    token,
    `/accounts/${accountID}/r2/buckets/${encodeURIComponent(name)}`,
    request,
  )
  if (bucket !== null) throw new CanaryResourceError(`Canary R2 bucket already exists: ${name}`)

  const databases = await cloudflareResult<unknown>(
    accountID,
    token,
    `/accounts/${accountID}/d1/database?${new URLSearchParams({ name, per_page: "50" })}`,
    request,
  )
  if (d1List(databases).some((database) => database.name === name)) {
    throw new CanaryResourceError(`Canary D1 database already exists: ${name}`)
  }
}

async function createD1Database(accountID: string, token: string, name: string, request: CanaryRequest) {
  const result = await cloudflareResult<D1Database>(accountID, token, `/accounts/${accountID}/d1/database`, request, {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
  })
  if (result.name !== name) throw new CanaryResourceError(`Cloudflare D1 create response did not confirm ${name}`)
  const id = typeof result.uuid === "string" ? result.uuid : typeof result.id === "string" ? result.id : ""
  return { id: validateDatabaseID(id), name }
}

async function createR2Bucket(accountID: string, token: string, name: string, request: CanaryRequest) {
  const result = await cloudflareResult<R2Bucket>(accountID, token, `/accounts/${accountID}/r2/buckets`, request, {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
  })
  if (result.name !== name) throw new CanaryResourceError(`Cloudflare R2 create response did not confirm ${name}`)
  return { name }
}

async function getWorkersDevSubdomain(accountID: string, token: string, request: CanaryRequest) {
  const result = await cloudflareResult<{ subdomain?: unknown }>(
    accountID,
    token,
    `/accounts/${accountID}/workers/subdomain`,
    request,
  )
  if (typeof result.subdomain !== "string" || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(result.subdomain)) {
    throw new CanaryResourceError("Cloudflare workers.dev subdomain is missing or invalid.")
  }
  return result.subdomain
}

async function cleanupCanaryResources(input: {
  accountID: string
  token: string
  name: string
  owned: OwnedResources
  request: CanaryRequest
  purge?: () => Promise<void>
  workerDeployed?: boolean
  containerApplicationID?: string
}): Promise<CanaryCleanupResult> {
  const result: CanaryCleanupResult = {
    name: input.name,
    deleted: [],
    skipped: [],
    failures: [],
    manualCleanup: [],
  }

  if (input.workerDeployed && !input.purge) {
    failCleanup(result, `worker:${input.name}`, "stop-and-purge-required")
    retainBackend(input, result)
    return result
  }

  const purged = await waitForPurge(input, result)

  let frontendClean = purged
  let namespaceID: string | undefined
  let containerApplicationID = input.containerApplicationID

  if (input.workerDeployed) {
    const worker = await verifyCanaryWorkerSettings(input, result)
    namespaceID = worker.namespaceID
    frontendClean &&= worker.ok
    if (worker.ok) {
      const container = await verifyCanaryContainerApplication(input, result, namespaceID, containerApplicationID)
      frontendClean &&= container.ok
      containerApplicationID = container.applicationID ?? containerApplicationID
    }
    if (frontendClean) {
      if (worker.exists) await deleteWorker(input, result)
      else result.skipped.push(`worker:${input.name}:missing`)
      if (containerApplicationID) await deleteContainerApplication(input, result, containerApplicationID)
    }
    frontendClean &&= result.failures.length === 0
  } else {
    result.skipped.push(`worker:${input.name}:not-marked-created`)
  }

  if (input.workerDeployed && !frontendClean) {
    retainBackend(input, result)
  } else if (!purged) result.skipped.push(`r2:${input.name}:purge-failed`)
  else if (input.owned.bucketName) await cleanupR2Bucket(input, result, input.owned.bucketName)
  else result.skipped.push(`r2:${input.name}:not-confirmed-created`)

  if (!input.workerDeployed || frontendClean) {
    if (input.owned.databaseID) await cleanupD1Database(input, result, input.owned.databaseID)
    else result.skipped.push(`d1:${input.name}:not-confirmed-created`)
  }

  return result
}

async function waitForPurge(
  input: { name: string; token: string; purge?: () => Promise<void> },
  result: CanaryCleanupResult,
) {
  if (!input.purge) return true
  try {
    await input.purge()
    return true
  } catch (error) {
    result.failures.push({ resource: `purge:${input.name}`, message: safeThrownMessage(error, input.token) })
    result.manualCleanup.push(`r2:${input.name}:purge-failed`)
    return false
  }
}

async function cleanupD1Database(
  input: { accountID: string; token: string; name: string; request: CanaryRequest },
  result: CanaryCleanupResult,
  databaseID: string,
) {
  try {
    const database = await optionalCloudflareResult<D1Database>(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/d1/database/${databaseID}`,
      input.request,
    )
    if (database === null) return result.skipped.push(`d1:${databaseID}:missing`)
    if (database.name !== input.name) return failCleanup(result, `d1:${databaseID}`, "name-mismatch")
    await cloudflareResult(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/d1/database/${databaseID}`,
      input.request,
      {
        method: "DELETE",
      },
    )
    result.deleted.push(`d1:${databaseID}`)
  } catch (error) {
    result.failures.push({ resource: `d1:${databaseID}`, message: safeThrownMessage(error) })
    result.manualCleanup.push(`d1:${databaseID}`)
  }
}

async function cleanupR2Bucket(
  input: { accountID: string; token: string; name: string; request: CanaryRequest },
  result: CanaryCleanupResult,
  bucketName: string,
) {
  try {
    const bucket = await optionalCloudflareResult<R2Bucket>(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/r2/buckets/${encodeURIComponent(bucketName)}`,
      input.request,
    )
    if (bucket === null) return result.skipped.push(`r2:${bucketName}:missing`)
    if (bucket.name !== input.name) return failCleanup(result, `r2:${bucketName}`, "name-mismatch")
    await cloudflareResult(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/r2/buckets/${encodeURIComponent(bucketName)}`,
      input.request,
      { method: "DELETE" },
    )
    result.deleted.push(`r2:${bucketName}`)
  } catch (error) {
    result.failures.push({ resource: `r2:${bucketName}`, message: safeThrownMessage(error) })
    result.manualCleanup.push(`r2:${bucketName}`)
  }
}

async function verifyCanaryWorkerSettings(
  input: { accountID: string; token: string; name: string; request: CanaryRequest; owned: OwnedResources },
  result: CanaryCleanupResult,
) {
  try {
    const settings = await optionalCloudflareResult<WorkerMetadata>(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/workers/scripts/${encodeURIComponent(input.name)}/settings`,
      input.request,
    )
    if (settings === null) {
      failCleanup(result, `worker:${input.name}`, "settings-missing")
      return { ok: false as const, exists: false, namespaceID: undefined }
    }
    const verified = verifyWorkerBindings(settings, input.name, input.owned)
    if (!verified.ok) {
      failCleanup(result, `worker:${input.name}`, verified.reason)
      return { ok: false as const, exists: true, namespaceID: undefined }
    }
    return { ok: true as const, exists: true, namespaceID: verified.namespaceID }
  } catch (error) {
    result.failures.push({ resource: `worker:${input.name}`, message: safeThrownMessage(error) })
    result.manualCleanup.push(`worker:${input.name}`)
    return { ok: false as const, exists: false, namespaceID: undefined }
  }
}

async function deleteWorker(
  input: { accountID: string; token: string; name: string; request: CanaryRequest },
  result: CanaryCleanupResult,
) {
  try {
    await cloudflareResult(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/workers/scripts/${encodeURIComponent(input.name)}`,
      input.request,
      { method: "DELETE" },
    )
    result.deleted.push(`worker:${input.name}`)
  } catch (error) {
    result.failures.push({ resource: `worker:${input.name}`, message: safeThrownMessage(error) })
    result.manualCleanup.push(`worker:${input.name}`)
  }
}

async function verifyCanaryContainerApplication(
  input: { accountID: string; token: string; name: string; request: CanaryRequest },
  result: CanaryCleanupResult,
  namespaceID: string | undefined,
  applicationID?: string,
) {
  if (!namespaceID) return { ok: true as const, applicationID: undefined }

  if (!applicationID) {
    try {
      const applications = await rawResult<unknown>(
        input.accountID,
        input.token,
        `/accounts/${input.accountID}/containers/applications?${new URLSearchParams({ name: input.name })}`,
        input.request,
      )
      const exactName = containerList(applications).filter((application) => application.name === input.name)
      if (exactName.length === 0) {
        result.skipped.push(`container:${input.name}:missing`)
        return { ok: true as const, applicationID: undefined }
      }
      if (exactName.length > 1) {
        failCleanup(result, `container:${input.name}`, "multiple-container-applications")
        return { ok: false as const, applicationID: undefined }
      }
      const match = exactName.find((application) => isOwnedContainerApplication(application, input.name, namespaceID))
      if (!match) {
        failCleanup(result, `container:${input.name}`, "matching-container-application-not-found")
        return { ok: false as const, applicationID: undefined }
      }
      if (typeof match.id !== "string") {
        failCleanup(result, `container:${input.name}`, "application-id-missing")
        return { ok: false as const, applicationID: undefined }
      }
      applicationID = String(match.id)
    } catch (error) {
      result.failures.push({ resource: `container:${input.name}`, message: safeThrownMessage(error) })
      result.manualCleanup.push(`container-application:${input.name}`)
      return { ok: false as const, applicationID: undefined }
    }
  }

  if (!uuid.test(applicationID)) {
    failCleanup(result, `container:${input.name}`, "invalid-application-id")
    return { ok: false as const, applicationID: undefined }
  }

  try {
    const application = await optionalRawResult<ContainerApplication>(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/containers/applications/${applicationID}`,
      input.request,
    )
    if (application === null) {
      result.skipped.push(`container:${applicationID}:missing`)
      return { ok: true as const, applicationID }
    }
    if (!isOwnedContainerApplication(application, input.name, namespaceID)) {
      failCleanup(result, `container:${applicationID}`, "association-mismatch")
      return { ok: false as const, applicationID: undefined }
    }
    return { ok: true as const, applicationID }
  } catch (error) {
    result.failures.push({ resource: `container:${applicationID}`, message: safeThrownMessage(error) })
    result.manualCleanup.push(`container-application:${applicationID}`)
    return { ok: false as const, applicationID: undefined }
  }
}

async function deleteContainerApplication(
  input: { accountID: string; token: string; name: string; request: CanaryRequest },
  result: CanaryCleanupResult,
  applicationID: string,
) {
  try {
    await rawResult(
      input.accountID,
      input.token,
      `/accounts/${input.accountID}/containers/applications/${applicationID}`,
      input.request,
      {
        method: "DELETE",
      },
    )
    result.deleted.push(`container:${applicationID}`)
  } catch (error) {
    result.failures.push({ resource: `container:${applicationID}`, message: safeThrownMessage(error) })
    result.manualCleanup.push(`container-application:${applicationID}`)
  }
}

function verifyWorkerBindings(settings: WorkerMetadata, name: string, owned: OwnedResources) {
  const bindings = Array.isArray(settings.bindings) ? settings.bindings.filter(record) : []
  const history = bindings.find((binding) => binding.name === "HISTORY")
  if (!history || history.type !== "d1" || history.id !== owned.databaseID) {
    return { ok: false as const, reason: "history-binding-mismatch" }
  }
  const backups = bindings.find((binding) => binding.name === "RUNTIME_BACKUPS")
  if (!backups || backups.type !== "r2_bucket" || backups.bucket_name !== name) {
    return { ok: false as const, reason: "backup-binding-mismatch" }
  }
  const sandbox = bindings.find((binding) => binding.name === "Sandbox")
  if (!sandbox || sandbox.type !== "durable_object_namespace" || sandbox.class_name !== "CanarySandbox") {
    return { ok: false as const, reason: "sandbox-binding-mismatch" }
  }
  if (typeof sandbox.namespace_id !== "string" || !sandbox.namespace_id) {
    return { ok: false as const, reason: "sandbox-namespace-missing" }
  }
  return { ok: true as const, namespaceID: sandbox.namespace_id }
}

function isOwnedContainerApplication(application: ContainerApplication, name: string, namespaceID: string) {
  if (application.name !== name) return false
  return hasCanaryContainerAssociation(application.durable_objects, namespaceID)
}

function hasCanaryContainerAssociation(value: unknown, namespaceID: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasCanaryContainerAssociation(item, namespaceID))
  if (!record(value)) return false
  return value.namespace_id === namespaceID
}

function containerList(value: unknown): ContainerApplication[] {
  if (Array.isArray(value)) return value.filter(record)
  if (record(value) && Array.isArray(value.applications)) return value.applications.filter(record)
  if (record(value) && Array.isArray(value.items)) return value.items.filter(record)
  if (record(value) && Array.isArray(value.result)) return value.result.filter(record)
  throw new CanaryResourceError("Cloudflare containers list response shape is invalid.")
}

function retainBackend(input: { name: string; owned: OwnedResources }, result: CanaryCleanupResult) {
  if (input.owned.bucketName) {
    result.skipped.push(`r2:${input.name}:frontend-cleanup-failed`)
    result.manualCleanup.push(`r2:${input.name}`)
  }
  if (input.owned.databaseID) {
    result.skipped.push(`d1:${input.owned.databaseID}:frontend-cleanup-failed`)
    result.manualCleanup.push(`d1:${input.owned.databaseID}`)
  }
}

function failCleanup(result: CanaryCleanupResult, resource: string, message: string) {
  result.failures.push({ resource, message })
  result.manualCleanup.push(resource)
}

async function optionalCloudflareResult<T>(
  accountID: string,
  token: string,
  path: string,
  request: CanaryRequest,
  init: RequestInit = {},
) {
  const { response, body } = await boundedFetch(request, token, path, init)
  if (response.status === 404) return null
  return unwrapCloudflare<T>(response, body, token)
}

async function cloudflareResult<T>(
  accountID: string,
  token: string,
  path: string,
  request: CanaryRequest,
  init: RequestInit = {},
) {
  validateAccountID(accountID)
  const { response, body } = await boundedFetch(request, token, path, init)
  return unwrapCloudflare<T>(response, body, token)
}

async function optionalRawResult<T>(
  accountID: string,
  token: string,
  path: string,
  request: CanaryRequest,
  init: RequestInit = {},
) {
  validateAccountID(accountID)
  const { response, body } = await boundedFetch(request, token, path, init)
  if (response.status === 404) return null
  return unwrapRaw<T>(response, body, token, init.method === "DELETE")
}

async function rawResult<T>(
  accountID: string,
  token: string,
  path: string,
  request: CanaryRequest,
  init: RequestInit = {},
) {
  validateAccountID(accountID)
  const { response, body } = await boundedFetch(request, token, path, init)
  return unwrapRaw<T>(response, body, token, init.method === "DELETE")
}

async function boundedFetch(request: CanaryRequest, token: string, path: string, init: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), defaultTimeoutMs)
  try {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${token}`)
    return await request(`${cloudflareAPI}${path}`, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers,
    }).then(async (response) => ({ response, body: await readBounded(response) }))
  } catch (error) {
    if (error instanceof CanaryResourceError) throw error
    throw new CanaryResourceError(`Cloudflare request failed: ${safeThrownMessage(error, token)}`)
  } finally {
    clearTimeout(timeout)
  }
}

async function readBounded(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > maxResponseBytes) {
      await reader.cancel()
      throw new CanaryResourceError(`Cloudflare response exceeded ${maxResponseBytes} bytes.`)
    }
    chunks.push(next.value)
  }
  return new TextDecoder().decode(concat(chunks, total))
}

function unwrapCloudflare<T>(response: Response, body: string, token: string): T {
  const payload = parseJSON<CloudflareEnvelope<T>>(body)
  if (!response.ok || payload.success === false) {
    throw new CanaryResourceError(
      `Cloudflare API request failed (HTTP ${response.status}${errorSummary(payload, token)})`,
    )
  }
  if (!("result" in payload)) throw new CanaryResourceError("Cloudflare API response is missing result.")
  return payload.result as T
}

function unwrapRaw<T>(response: Response, body: string, token: string, allowEmptyDelete: boolean): T {
  if (allowEmptyDelete && response.status === 204 && body === "") return undefined as T
  const payload = parseJSON<CloudflareEnvelope<T> | T>(body)
  if (!response.ok || (record(payload) && payload.success === false))
    throw new CanaryResourceError(
      `Cloudflare containers request failed (HTTP ${response.status}${errorSummary(payload, token)})`,
    )
  if (record(payload) && "success" in payload && "result" in payload) return payload.result as T
  return payload as T
}

function parseJSON<T>(body: string): T {
  try {
    return JSON.parse(body) as T
  } catch {
    throw new CanaryResourceError("Cloudflare API response was not valid JSON.")
  }
}

function d1List(value: unknown): Array<{ name?: unknown; uuid?: unknown }> {
  if (Array.isArray(value)) return value.filter(record)
  if (record(value) && Array.isArray(value.result)) return value.result.filter(record)
  throw new CanaryResourceError("Cloudflare D1 list response shape is invalid.")
}

function errorSummary(payload: unknown, token: string) {
  if (!record(payload) || !Array.isArray(payload.errors)) return ""
  const first = payload.errors.find(record)
  if (!first) return ""
  const code =
    typeof first.code === "number" || typeof first.code === "string" ? `, code ${String(first.code).slice(0, 24)}` : ""
  const message = typeof first.message === "string" ? `: ${sanitize(first.message, token)}` : ""
  return `${code}${message}`
}

function validateAccountID(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new TypeError("Cloudflare accountID must be exactly 32 lowercase hex characters.")
  }
  return value
}

function validateCanaryName(value: string) {
  if (typeof value !== "string" || !/^mgpt-canary-[0-9]{1,12}-[0-9]{1,3}$/.test(value)) {
    throw new TypeError("Canary resource name is invalid.")
  }
  return value
}

function validateDatabaseID(value: string) {
  if (!uuid.test(value)) throw new TypeError("Cloudflare D1 database ID is invalid.")
  return value
}

function validateToken(value: string) {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /[\r\n]/.test(value)) {
    throw new TypeError("Cloudflare API token is invalid.")
  }
  return value
}

function safeThrownMessage(error: unknown, token?: string) {
  return sanitize(error instanceof Error ? error.message : String(error), token)
}

function sanitize(value: string, token?: string) {
  const exactTokenPattern = token ? new RegExp(escapeRegExp(token), "g") : undefined
  const redacted = exactTokenPattern ? value.replace(exactTokenPattern, "[redacted]") : value
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 240)
}

function canaryRateLimitNamespaceID(name: string, salt: "burst" | "rate") {
  let hash = 2166136261
  for (const char of `${name}:${salt}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return String(100_000_000 + (hash % 900_000_000))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function concat(chunks: Uint8Array[], total: number) {
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
