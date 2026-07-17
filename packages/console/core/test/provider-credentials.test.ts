import { describe, expect, test } from "bun:test"
import { ProviderCredentials } from "../src/provider-credentials"

const input = {
  workspaceID: "wrk_test",
  provider: "openai",
  credentials: "sk-secret-value",
  keyMaterial: "test-encryption-key",
}

describe("provider credentials", () => {
  test("encrypts and decrypts credentials", async () => {
    const credentials = await ProviderCredentials.encrypt(input)

    expect(ProviderCredentials.encrypted(credentials)).toBe(true)
    expect(credentials.startsWith("mgp-byok:v1:k1:")).toBe(true)
    expect(credentials).not.toContain(input.credentials)
    expect(await ProviderCredentials.decrypt({ ...input, credentials })).toBe(input.credentials)
  })

  test("uses a unique nonce for each encryption", async () => {
    const first = await ProviderCredentials.encrypt(input)
    const second = await ProviderCredentials.encrypt(input)

    expect(first).not.toBe(second)
  })

  test("binds ciphertext to the workspace and provider", async () => {
    const credentials = await ProviderCredentials.encrypt(input)

    await expectFailure(
      () => ProviderCredentials.decrypt({ ...input, workspaceID: "wrk_other", credentials }),
      "could not be decrypted",
    )
    await expectFailure(
      () => ProviderCredentials.decrypt({ ...input, provider: "anthropic", credentials }),
      "could not be decrypted",
    )
  })

  test("rejects the wrong encryption key", async () => {
    const credentials = await ProviderCredentials.encrypt(input)

    await expectFailure(
      () => ProviderCredentials.decrypt({ ...input, keyMaterial: "wrong-key", credentials }),
      "could not be decrypted",
    )
  })

  test("accepts legacy plaintext for a controlled backfill", async () => {
    expect(await ProviderCredentials.decrypt(input)).toBe(input.credentials)
  })

  test("rejects malformed encrypted envelopes", async () => {
    await expectFailure(
      () => ProviderCredentials.decrypt({ ...input, credentials: "mgp-byok:v2:bad:envelope" }),
      "envelope is invalid",
    )
    await expectFailure(
      () => ProviderCredentials.decrypt({ ...input, credentials: "mgp-byok:v1:k1:missing" }),
      "envelope is invalid",
    )
  })

  test("rejects an unavailable key id", async () => {
    const credentials = await ProviderCredentials.encrypt(input)

    await expectFailure(
      () =>
        ProviderCredentials.decrypt({
          workspaceID: input.workspaceID,
          provider: input.provider,
          credentials: credentials.replace(":k1:", ":retired:"),
        }),
      "could not be decrypted",
    )
  })
})

async function expectFailure(run: () => Promise<unknown>, message: string) {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  if (!(caught instanceof Error)) throw new Error("Expected provider credential operation to fail")
  expect(caught.message).toContain(message)
}
