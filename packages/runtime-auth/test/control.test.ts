import { describe, expect, test } from "bun:test"
import {
  checkpointControlEnv,
  checkpointControlHeader,
  deriveCheckpointControlToken,
  deriveControlToken,
  matchesControlToken,
  sdkControlEnv,
  sdkControlHeader,
  validControlToken,
} from "../src/control"

const secret = "control-secret-that-is-at-least-thirty-two-characters"
const otherSecret = "different-control-secret-at-least-thirty-two-characters"
const scope = "account:acc_control/workspace:wrk_control"

describe("control tokens", () => {
  test("exports stable header and environment names", () => {
    expect(sdkControlHeader).toBe("x-mongolgpt-control-token")
    expect(checkpointControlHeader).toBe("x-mongolgpt-checkpoint-token")
    expect(sdkControlEnv).toBe("MONGOLGPT_SDK_CONTROL_TOKEN")
    expect(checkpointControlEnv).toBe("MONGOLGPT_CHECKPOINT_CONTROL_TOKEN")
  })

  test("derives deterministic lowercase HMAC tokens", async () => {
    await expect(deriveControlToken(secret, scope, "sdk")).resolves.toBe(
      "c3bcc570abd4ea07540b2d0b4e691d0ef05fba1b44b4b15f612bcb466aa9041f",
    )
    await expect(deriveControlToken(secret, scope, "checkpoint")).resolves.toBe(
      "370c7517cee3cbc8525c55eabad86f68d94711a54160b657de6f6e6f29c2bf99",
    )
  })

  test("isolates purpose, scope, and secret", async () => {
    const token = await deriveControlToken(secret, scope, "checkpoint")

    expect(await deriveControlToken(secret, `${scope}:other`, "checkpoint")).not.toBe(token)
    expect(await deriveControlToken(secret, scope, "sdk")).not.toBe(token)
    expect(await deriveControlToken(otherSecret, scope, "checkpoint")).not.toBe(token)
  })

  test("derives checkpoint tokens from the bounded account and workspace scope tuple", async () => {
    await expect(
      deriveCheckpointControlToken(secret, { accountID: "acc_control", workspaceID: "wrk_control" }),
    ).resolves.toBe("9abd835d993bd9a29e6fca400d26ac3c909f65080ec0895907e2757ed3e67262")

    await expect(deriveCheckpointControlToken(secret, { accountID: "", workspaceID: "wrk_control" })).rejects.toThrow()
    await expect(
      deriveCheckpointControlToken(secret, { accountID: "acc_control", workspaceID: `wrk_${"x".repeat(257)}` }),
    ).rejects.toThrow()
    await expect(
      deriveCheckpointControlToken(secret, { accountID: "acc_\ncontrol", workspaceID: "wrk_control" }),
    ).rejects.toThrow()
  })

  test("rejects invalid secret, scope, and purpose inputs", async () => {
    await expect(deriveControlToken("short", scope, "checkpoint")).rejects.toThrow()
    await expect(deriveControlToken("x".repeat(8193), scope, "checkpoint")).rejects.toThrow()
    await expect(deriveControlToken(secret, "", "checkpoint")).rejects.toThrow()
    await expect(deriveControlToken(secret, "x".repeat(1025), "checkpoint")).rejects.toThrow()
    await expect(deriveControlToken(secret, "scope\u007f", "checkpoint")).rejects.toThrow()
    await expect(deriveControlToken(secret, scope, "worker" as unknown as "checkpoint")).rejects.toThrow()
  })

  test("validates exact lowercase 64-character hex tokens", () => {
    const valid = "a".repeat(64)

    expect(validControlToken(valid)).toBe(true)
    expect(validControlToken("A".repeat(64))).toBe(false)
    expect(validControlToken("a".repeat(63))).toBe(false)
    expect(validControlToken("a".repeat(65))).toBe(false)
    expect(validControlToken(`${valid}\n`)).toBe(false)
    expect(validControlToken(`${valid}\r\n`)).toBe(false)
    expect(validControlToken(`${valid}\u2028`)).toBe(false)
    expect(validControlToken(`${valid}\u2029`)).toBe(false)
    expect(validControlToken(`${"a".repeat(63)}g`)).toBe(false)
    expect(validControlToken(null)).toBe(false)
  })

  test("compares only validated fixed-length token bytes without throwing", async () => {
    const token = await deriveControlToken(secret, scope, "checkpoint")

    expect(matchesControlToken(token, token)).toBe(true)
    expect(matchesControlToken(token.replace(/^./, "0"), token)).toBe(false)
    expect(matchesControlToken(null, token)).toBe(false)
    expect(matchesControlToken("A".repeat(64), token)).toBe(false)
    expect(matchesControlToken(`${token}\n`, token)).toBe(false)
    expect(matchesControlToken(`${token}\r\n`, token)).toBe(false)
    expect(matchesControlToken(`${token}\u2028`, token)).toBe(false)
    expect(matchesControlToken(`${token}\u2029`, token)).toBe(false)
    expect(matchesControlToken(token, "not-a-token")).toBe(false)
  })
})
