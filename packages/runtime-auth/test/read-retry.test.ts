import { expect, test } from "bun:test"
import { isRuntimeReadRetryScope, runtimeReadRetryScope } from "../src/read-retry"

test("read retry scope is stable across credential refresh but partitions identity", async () => {
  const identity = { accountID: "acc_test", workspaceID: "wrk_test", authVersion: 1 }
  const scope = await runtimeReadRetryScope(identity)
  expect(isRuntimeReadRetryScope(scope)).toBe(true)
  expect(await runtimeReadRetryScope(identity)).toBe(scope)
  for (const change of [{ accountID: "acc_other" }, { workspaceID: "wrk_other" }, { authVersion: 2 }]) {
    expect(await runtimeReadRetryScope({ ...identity, ...change })).not.toBe(scope)
  }
  expect(scope).not.toContain(identity.accountID)
  expect(scope).not.toContain(identity.workspaceID)
})

test("only accepts the finite wire format", () => {
  for (const value of [null, "", "v1.secret", `v1.${"0".repeat(63)}`, `v1.${"A".repeat(64)}`, `v2.${"0".repeat(64)}`]) {
    expect(isRuntimeReadRetryScope(value)).toBe(false)
  }
})
