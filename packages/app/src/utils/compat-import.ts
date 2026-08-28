import type { ServerSDK } from "@/context/server-sdk"

export type CompatImportType = "auto" | "mcp" | "skill" | "plugin"
export type CompatImportScope = "global" | "project"

export type CompatImportPayload = {
  source?: string
  type?: CompatImportType
  name?: string
  scope?: CompatImportScope
  mcpCommand?: string
  url?: string
  env?: string[]
  header?: string[]
  force?: boolean
  adapter?: boolean
}

export type CompatOperation = {
  kind: "mcp" | "skill-path" | "skill-url" | "plugin"
  name?: string
  source: string
  value?: string
  config?: {
    type?: "local" | "remote"
    command?: string[]
    url?: string
  }
  spec?: string | [string, Record<string, unknown>]
  adapter?: {
    file: string
    target: string
    format: string
    original: string
  }
}

export type CompatPatchOutcome = {
  mode: "add" | "replace" | "noop"
  operation: CompatOperation
}

export type CompatImportResponse = {
  scope: CompatImportScope
  configPath: string
  operations: CompatOperation[]
  prepared: CompatOperation[]
  descriptions: string[]
  warnings: string[]
  outcomes: CompatPatchOutcome[]
  existingConfigText: string
  nextConfigText: string
  configExists: boolean
}

type CompatRequestMode = "plan" | "apply"

const invalidResponseMessage = "MongolGPT сервер нийцтэй байдлын импортын зөв JSON хариу буцаасангүй."

export async function requestCompatImport(input: {
  sdk: Pick<ServerSDK, "request">
  mode: CompatRequestMode
  payload: CompatImportPayload
  directory?: string
}) {
  const response = await input.sdk.request(`/compat/import/${input.mode}`, {
    method: "POST",
    directory: input.directory,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input.payload),
  })

  const json = isJsonContentType(response.headers.get("content-type"))
  const data = json ? await response.json().catch(() => undefined) : undefined

  if (!response.ok) {
    const message =
      isRecord(data) && typeof data.message === "string" && data.message.trim()
        ? data.message.trim().slice(0, 500)
        : `Тохирлын импорт HTTP ${response.status} төлөвөөр бүтэлгүйтлээ`
    throw new Error(message)
  }

  if (!json || !isCompatImportResponse(data)) throw new Error(invalidResponseMessage)
  return data
}

function isJsonContentType(value: string | null) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"))
}

function isCompatImportResponse(value: unknown): value is CompatImportResponse {
  if (!isRecord(value)) return false
  if (value.scope !== "global" && value.scope !== "project") return false
  if (typeof value.configPath !== "string" || typeof value.existingConfigText !== "string") return false
  if (typeof value.nextConfigText !== "string" || typeof value.configExists !== "boolean") return false
  if (!isStringArray(value.descriptions) || !isStringArray(value.warnings)) return false
  if (!Array.isArray(value.operations) || !value.operations.every(isCompatOperation)) return false
  if (!Array.isArray(value.prepared) || !value.prepared.every(isCompatOperation)) return false
  return Array.isArray(value.outcomes) && value.outcomes.every(isCompatOutcome)
}

function isCompatOutcome(value: unknown): value is CompatPatchOutcome {
  return (
    isRecord(value) &&
    (value.mode === "add" || value.mode === "replace" || value.mode === "noop") &&
    isCompatOperation(value.operation)
  )
}

function isCompatOperation(value: unknown): value is CompatOperation {
  if (!isRecord(value) || typeof value.source !== "string") return false
  if (value.kind === "skill-path" || value.kind === "skill-url") return typeof value.value === "string"
  if (value.kind === "mcp") return typeof value.name === "string" && isRecord(value.config)
  if (value.kind !== "plugin") return false
  if (!isPluginSpec(value.spec)) return false
  if (value.adapter === undefined) return true
  return (
    isRecord(value.adapter) &&
    typeof value.adapter.file === "string" &&
    typeof value.adapter.target === "string" &&
    typeof value.adapter.format === "string" &&
    typeof value.adapter.original === "string"
  )
}

function isPluginSpec(value: unknown) {
  if (typeof value === "string") return true
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && isRecord(value[1])
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
