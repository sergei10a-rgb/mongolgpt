import { describe, expect, test } from "bun:test"
import { prepareRuntimeAccountCleanup } from "../src/runtime-account-cleanup"

const request = { accountID: "acc_test", requestID: "del_test", workspaceIDs: ["wrk_test"] }
const available = async () => ({ ready: true, protocol: 1 })

describe("runtime erasure service client", () => {
  test("requires configured, healthy and version-matched binding before retirement", async () => {
    for (const value of [
      undefined,
      {},
      { ready: available },
      { ready: async () => ({ ready: false, protocol: 1 }), cleanup() {} },
      { ready: async () => ({ ready: true, protocol: 2 }), cleanup() {} },
    ])
      await expect(prepareRuntimeAccountCleanup(value)).rejects.toThrow("баталгаажуулж")
  })

  test("accepts only the matching final receipt after all incomplete pages", async () => {
    const calls: unknown[] = []
    const cleanup = await prepareRuntimeAccountCleanup({
      ready: available,
      cleanup: async (input: typeof request) => {
        calls.push(input)
        return { accountID: input.accountID, requestID: input.requestID, complete: calls.length === 3 }
      },
    })
    expect(await cleanup(request)).toEqual({
      accountID: request.accountID,
      requestID: request.requestID,
      complete: true,
    })
    expect(calls).toEqual([request, request, request])
  })

  test("does not turn malformed, other-account or incomplete results into completion", async () => {
    for (const response of [
      null,
      {},
      { ...request, complete: "true" },
      { ...request, accountID: "wrong", complete: true },
      { ...request, requestID: "wrong", complete: true },
    ]) {
      const cleanup = await prepareRuntimeAccountCleanup({ ready: available, cleanup: async () => response })
      await expect(cleanup(request)).rejects.toThrow("баталгаажуулж")
    }
    let pages = 0
    const cleanup = await prepareRuntimeAccountCleanup({
      ready: available,
      cleanup: async () => {
        pages++
        return { ...request, complete: false }
      },
    })
    await expect(cleanup(request)).rejects.toThrow("баталгаажуулж")
    expect(pages).toBe(40)
  })

  test("preserves request scope across a binding or caller mutating their input", async () => {
    let calls = 0
    const input = { ...request, workspaceIDs: [...request.workspaceIDs] }
    const cleanup = await prepareRuntimeAccountCleanup({
      ready: available,
      cleanup: async (value: typeof input) => {
        expect(value).toEqual(request)
        input.workspaceIDs.push("wrk_wrong")
        value.workspaceIDs.push("wrk_wrong")
        return { accountID: request.accountID, requestID: request.requestID, complete: ++calls === 2 }
      },
    })
    expect((await cleanup(input)).complete).toBe(true)
  })

  test("does not expose private transport details", async () => {
    await expect(
      prepareRuntimeAccountCleanup({
        ready: async () => {
          throw new Error("private key")
        },
        cleanup() {},
      }),
    ).rejects.toThrow(/^Cloud /)
    const cleanup = await prepareRuntimeAccountCleanup({
      ready: available,
      cleanup: async () => {
        throw new Error("private service data")
      },
    })
    const error = await cleanup(request).catch((e) => e)
    expect(error.message).not.toContain("private")
  })
})
