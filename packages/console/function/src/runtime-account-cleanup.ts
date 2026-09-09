import type { RuntimeAccountCleanup } from "@mongolgpt/console-core/account-deletion-worker.js"

type Binding = { ready(): Promise<unknown>; cleanup(input: Parameters<RuntimeAccountCleanup>[0]): Promise<unknown> }
const message = "Cloud өгөгдлийг цэвэрлэж дууссаныг баталгаажуулж чадсангүй"

// Preflight runs before the console makes any account retirement irreversible.
// Incomplete pages remain durable in runtime D1; the next cron resumes them.
export async function prepareRuntimeAccountCleanup(value: unknown): Promise<RuntimeAccountCleanup> {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      !("ready" in value) ||
      typeof value.ready !== "function" ||
      !("cleanup" in value) ||
      typeof value.cleanup !== "function"
    )
      throw new Error(message)
    const binding = value as Binding
    const ready = await bounded(binding.ready(), 5_000)
    if (!record(ready) || ready.ready !== true || ready.protocol !== 1) throw new Error(message)
    return async (input) => {
      const scope = { accountID: input.accountID, requestID: input.requestID, workspaceIDs: [...input.workspaceIDs] }
      const start = Date.now()
      try {
        for (let page = 0; page < 40 && Date.now() - start < 120_000; page++) {
          const receipt = await bounded(binding.cleanup({ ...scope, workspaceIDs: [...scope.workspaceIDs] }), 30_000)
          if (
            !record(receipt) ||
            receipt.accountID !== scope.accountID ||
            receipt.requestID !== scope.requestID ||
            typeof receipt.complete !== "boolean"
          )
            throw new Error(message)
          if (receipt.complete) return { accountID: scope.accountID, requestID: scope.requestID, complete: true }
        }
      } catch {
        throw new Error(message)
      }
      throw new Error(message)
    }
  } catch {
    throw new Error(message)
  }
}

async function bounded<T>(work: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
