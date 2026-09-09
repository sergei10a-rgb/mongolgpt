export type SandboxRetirement = {
  accountID: string
  workspaceID: string
  requestID: string
}

const storageKey = "mongolgpt:retired:v1"
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/

// The seal survives DO eviction. Pending operations are drained only in this
// incarnation; container destruction is still required after every restart.
export function createSandboxRetirement(storage: Pick<DurableObjectStorage, "get" | "put">) {
  let retired: SandboxRetirement | undefined
  let writing: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const ready = storage.get<unknown>(storageKey).then((value) => {
    if (value !== undefined) retired = validateSandboxRetirement(value)
  })

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    await ready
    if (retired) throw new Error("Ажиллах орчин бүрмөсөн хаагдсан байна.")
    const work = Promise.resolve().then(() => {
      if (retired) throw new Error("Ажиллах орчин бүрмөсөн хаагдсан байна.")
      return operation()
    })
    pending.add(work)
    try {
      return await work
    } finally {
      pending.delete(work)
    }
  }

  async function seal(value: SandboxRetirement) {
    const input = validateSandboxRetirement(value)
    await ready
    if (
      retired &&
      (retired.accountID !== input.accountID ||
        retired.workspaceID !== input.workspaceID ||
        retired.requestID !== input.requestID)
    )
      throw new Error("Ажиллах орчны устгалын хүсэлт зөрсөн байна.")
    // Never reopen local admission after an uncertain persistence acknowledgement.
    retired = input
    writing ??= storage.put(storageKey, input)
    const current = writing
    try {
      await current
    } finally {
      if (writing === current) writing = undefined
    }
  }

  async function drain() {
    await ready
    if (!retired) throw new Error("Ажиллах орчны устгал эхлээгүй байна.")
    while (pending.size) await Promise.allSettled([...pending])
  }

  return { ready, run, seal, drain }
}

export function validateSandboxRetirement(value: unknown): SandboxRetirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Устгалын хүсэлт буруу байна.")
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).sort().join(",") !== "accountID,requestID,workspaceID" ||
    ![input.accountID, input.workspaceID, input.requestID].every((id) => typeof id === "string" && identifier.test(id))
  )
    throw new TypeError("Устгалын хүсэлт буруу байна.")
  return {
    accountID: input.accountID as string,
    workspaceID: input.workspaceID as string,
    requestID: input.requestID as string,
  }
}
