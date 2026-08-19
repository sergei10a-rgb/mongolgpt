import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"

import { AccountTokenCodecError, createAccountTokenCodec } from "../../src/account/token-codec"

describe("account token codec", () => {
  test("encrypts and decrypts without exposing plaintext", () => {
    const codec = createAccountTokenCodec(randomBytes(32))
    const token = "sensitive-access-token"
    const protectedValue = codec.protect(token)

    expect(protectedValue).toStartWith("mgpt:v1:")
    expect(protectedValue).not.toContain(token)
    expect(codec.unprotect(protectedValue)).toBe(token)
  })

  test("uses a fresh nonce for every encryption", () => {
    const codec = createAccountTokenCodec(randomBytes(32))
    expect(codec.protect("same-token")).not.toBe(codec.protect("same-token"))
  })

  test("does not mistake a legacy plaintext prefix for an encrypted envelope", () => {
    const codec = createAccountTokenCodec(randomBytes(32))
    const legacy = "mgpt:v1:legacy-oauth-token"
    expect(codec.protected(legacy)).toBe(false)
    expect(codec.unprotect(codec.protect(legacy))).toBe(legacy)
  })

  test("rejects keys with the wrong length", () => {
    expect(() => createAccountTokenCodec(randomBytes(31))).toThrow(AccountTokenCodecError)
  })

  test("rejects tampered ciphertext", () => {
    const codec = createAccountTokenCodec(randomBytes(32))
    const value = codec.protect("token")
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`
    expect(() => codec.unprotect(tampered)).toThrow(AccountTokenCodecError)
  })

  test("rejects malformed encrypted envelopes instead of treating them as plaintext", () => {
    const codec = createAccountTokenCodec(randomBytes(32))
    expect(() => codec.unprotect("mgpt:v1:not-an-envelope")).toThrow(AccountTokenCodecError)
    expect(() => codec.unprotect("mgpt:v1:AA:BB:CC")).toThrow(AccountTokenCodecError)
  })

  test("missing key fails closed for plaintext and encrypted tokens", () => {
    const unavailable = createAccountTokenCodec()
    const encrypted = createAccountTokenCodec(randomBytes(32)).protect("token")
    expect(() => unavailable.protect("token")).toThrow(AccountTokenCodecError)
    expect(() => unavailable.unprotect("plaintext-token")).toThrow(AccountTokenCodecError)
    expect(() => unavailable.unprotect(encrypted)).toThrow(AccountTokenCodecError)
  })
})
