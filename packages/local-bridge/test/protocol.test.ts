import { describe, expect, test } from "bun:test"
import {
  LocalBridgeProtocolError,
  createLocalBridgeAuthorizationCode,
  createLocalBridgeCallback,
  createLocalBridgePairing,
  localBridgePairingUrl,
  parseLocalBridgeCallback,
  parseLocalBridgePairingUrl,
  verifyLocalBridgeChallenge,
} from "../src"

const origin = "https://app.dev.mgpt.mn"
const accountID = "usr_01HZX9MONGOLGPT"
const state = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"
const challenge = "NI6jF3FS5EZ4JkGRCj76yNqV7QpQgOO00Ko2rMiwsCI"
const code = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"

function deterministicRandom() {
  let value = 0
  return (length: number) => new Uint8Array(length).fill(++value)
}

describe("local bridge pairing protocol", () => {
  test("creates and parses an origin-bound PKCE pairing request", async () => {
    const pairing = await createLocalBridgePairing({ origin, accountID, randomBytes: deterministicRandom() })
    expect(pairing.verifier).toBe("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")
    expect(parseLocalBridgePairingUrl(pairing.url, [origin])).toEqual(pairing.request)
    expect(await verifyLocalBridgeChallenge(pairing.verifier, pairing.request.challenge)).toBe(true)
    expect(await verifyLocalBridgeChallenge(state, pairing.request.challenge)).toBe(false)
  })

  test("rejects an unapproved or insecure remote app origin", () => {
    const url = localBridgePairingUrl({ version: 1, origin, accountID, state, challenge })
    expect(() => parseLocalBridgePairingUrl(url, ["https://app.mgpt.mn"])).toThrow(LocalBridgeProtocolError)
    expect(() =>
      localBridgePairingUrl({ version: 1, origin: "http://attacker.example", accountID, state, challenge }),
    ).toThrow(LocalBridgeProtocolError)
  })

  test("rejects duplicate, unknown, malformed, and credential-bearing request fields", () => {
    const valid = localBridgePairingUrl({ version: 1, origin, accountID, state, challenge })
    const duplicate = new URL(valid)
    duplicate.searchParams.append("state", state)
    const unknown = new URL(valid)
    unknown.searchParams.set("token", code)
    const credential = new URL(valid)
    credential.username = "attacker"

    for (const value of [duplicate, unknown, credential]) {
      expect(() => parseLocalBridgePairingUrl(value.toString(), [origin])).toThrow(LocalBridgeProtocolError)
    }
  })

  test("round-trips a callback without exposing a bridge bearer token", () => {
    const callback = createLocalBridgeCallback({ origin, state, port: 47_321, code })
    expect(new URL(callback).search).toBe("")
    expect(parseLocalBridgeCallback(callback, origin)).toEqual({
      version: 1,
      origin,
      state,
      port: 47_321,
      code,
    })
  })

  test("rejects callback origin, state, code, port, and field smuggling", () => {
    const callback = new URL(createLocalBridgeCallback({ origin, state, port: 47_321, code }))
    expect(() => parseLocalBridgeCallback(callback.toString(), "https://app.mgpt.mn")).toThrow(LocalBridgeProtocolError)

    for (const hash of [
      `bridge=mongolgpt-bridge-v1&state=bad&port=47321&code=${code}`,
      `bridge=mongolgpt-bridge-v1&state=${state}&port=80&code=${code}`,
      `bridge=mongolgpt-bridge-v1&state=${state}&port=47321&code=bad`,
      `${callback.hash.slice(1)}&token=secret`,
    ]) {
      callback.hash = hash
      expect(() => parseLocalBridgeCallback(callback.toString(), origin)).toThrow(LocalBridgeProtocolError)
    }
  })

  test("creates fixed-size authorization codes and rejects broken entropy sources", () => {
    expect(createLocalBridgeAuthorizationCode(() => new Uint8Array(32).fill(3))).toBe(code)
    expect(() => createLocalBridgeAuthorizationCode(() => new Uint8Array(31))).toThrow(LocalBridgeProtocolError)
  })
})
