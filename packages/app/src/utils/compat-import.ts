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

export async function requestCompatImport(input: {
  sdk: ServerSDK
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

  const contentType = response.headers.get("content-type") ?? ""
  const data = contentType.includes("application/json") ? await response.json() : await response.text()

  if (!response.ok) {
    const message =
      typeof data === "object" && data && "message" in data
        ? String((data as { message?: unknown }).message)
        : typeof data === "string" && data
          ? data
          : `Compat import failed with HTTP ${response.status}`
    throw new Error(message)
  }

  return data as CompatImportResponse
}

