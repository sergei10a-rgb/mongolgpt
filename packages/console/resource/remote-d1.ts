import type { D1Database } from "@cloudflare/workers-types"

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type ApiMeta = {
  changes?: number
  changed_db?: boolean
  duration?: number
  last_row_id?: number
  rows_read?: number
  rows_written?: number
  size_after?: number
}

type ApiResult = {
  success?: boolean
  results?: Record<string, unknown>[] | { columns?: string[]; rows?: unknown[][] }
  meta?: ApiMeta
}

type ApiEnvelope = {
  success: boolean
  errors?: { message?: string }[]
  result?: ApiResult[]
}

export function createRemoteD1(input: {
  accountId: string
  databaseId: string
  apiToken: string
  fetch?: Fetch
}): D1Database {
  const request = input.fetch ?? fetch
  let transactionTail = Promise.resolve()
  const transactionReleases: (() => void)[] = []

  async function execute(sql: string, params: unknown[], raw: boolean) {
    const control = sql.trim().toLowerCase()
    if (control.startsWith("begin")) {
      const previous = transactionTail
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      transactionTail = previous.then(() => current)
      await previous
      transactionReleases.push(release)
      return emptyResult()
    }
    if (control === "commit" || control === "rollback") {
      transactionReleases.shift()?.()
      return emptyResult()
    }
    if (control.startsWith("savepoint ") || control.startsWith("release savepoint ") || control.startsWith("rollback to ")) {
      return emptyResult()
    }

    const endpoint = raw ? "raw" : "query"
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params: params.map(normalizeParameter) }),
      },
    )
    const payload = (await response.json()) as ApiEnvelope
    if (!response.ok || !payload.success || !payload.result?.[0]?.success) {
      const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ")
      throw new Error(`Cloudflare D1 query failed${detail ? `: ${detail}` : ""}`)
    }
    return payload.result[0]
  }

  function prepare(sql: string) {
    const statement = (params: unknown[] = []) => ({
      bind: (...next: unknown[]) => statement(next),
      run: () => execute(sql, params, false),
      all: () => execute(sql, params, false),
      first: async (column?: string) => {
        const result = await execute(sql, params, false)
        const row = Array.isArray(result.results) ? result.results[0] : undefined
        return column && row ? row[column] : row ?? null
      },
      raw: async () => {
        const result = await execute(sql, params, true)
        return Array.isArray(result.results) ? [] : (result.results?.rows ?? [])
      },
    })
    return statement()
  }

  const database = {
    prepare,
    async batch(statements: { run(): Promise<unknown> }[]) {
      const results: unknown[] = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
    async exec(sql: string) {
      const result = await execute(sql, [], false)
      return { count: 1, duration: result.meta?.duration ?? 0 }
    },
    async dump() {
      throw new Error("D1 dump is not available through the local REST adapter.")
    },
    withSession() {
      return database
    },
  }

  return database as unknown as D1Database
}

function normalizeParameter(value: unknown) {
  if (value === undefined) throw new TypeError("Cloudflare D1 does not accept undefined query parameters.")
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  return value
}

function emptyResult(): ApiResult {
  return {
    success: true,
    results: [],
    meta: { changes: 0, duration: 0, rows_read: 0, rows_written: 0 },
  }
}
