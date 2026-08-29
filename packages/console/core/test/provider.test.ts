import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Actor } from "../src/actor"
import { Provider } from "../src/provider"

const allowedProviders = ["openai", "anthropic", "google", "openrouter", "nvidia-nim"] as const

describe("provider input schema", () => {
  test("allows only the hosted BYOK provider allowlist", () => {
    for (const provider of allowedProviders) {
      expect(
        Provider.create.schema.safeParse({
          provider,
          credentials: " test-key ",
        }).success,
      ).toBe(true)
      expect(
        Provider.remove.schema.safeParse({
          provider,
        }).success,
      ).toBe(true)
    }

    expect(
      Provider.create.schema.safeParse({
        provider: "nvidia",
        credentials: "test-key",
      }).success,
    ).toBe(false)
    expect(
      Provider.remove.schema.safeParse({
        provider: "openai-compatible",
      }).success,
    ).toBe(false)
  })

  test("rejects blank, oversized, and extra credential input", () => {
    expect(
      Provider.create.schema.safeParse({
        provider: "openrouter",
        credentials: "   ",
      }).success,
    ).toBe(false)
    expect(
      Provider.create.schema.safeParse({
        provider: "openrouter",
        credentials: "x".repeat(16 * 1024 + 1),
      }).success,
    ).toBe(false)
    expect(
      Provider.create.schema.safeParse({
        provider: "openrouter",
        credentials: "test-key",
        extra: true,
      }).success,
    ).toBe(false)
    expect(
      Provider.remove.schema.safeParse({
        provider: "openrouter",
        extra: true,
      }).success,
    ).toBe(false)
  })
})

describe("provider authorization and listing contract", () => {
  test("keeps administrative authorization for create and remove", async () => {
    const actor = {
      userID: "usr_provider_member",
      workspaceID: "wrk_provider_member",
      accountID: "acc_provider_member",
      role: "member" as const,
    }

    await expect(
      Actor.provide("user", actor, () => Provider.create({ provider: "openai", credentials: "sk-test-key" })),
    ).rejects.toThrow("Энэ үйлдлийг хийх эрхгүй байна")
    await expect(
      Actor.provide("user", actor, () => Provider.remove({ provider: "openai" })),
    ).rejects.toThrow("Энэ үйлдлийг хийх эрхгүй байна")
  })

  test("list selects provider ids without returning credentials", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/provider.ts"), "utf8")

    expect(source).toContain("provider: ProviderTable.provider")
    expect(source).not.toContain("credentials: ProviderTable.credentials")
  })
})
