import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { localBridgeChallenge, type LocalBridgePairingRequest } from "@mongolgpt/local-bridge"
import { createLocalBridgeGateway } from "./local-bridge-gateway"

const origin = "https://app.dev.mgpt.mn"
const verifier = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
const state = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"
const accountID = "usr_local_bridge"
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

async function pairing(): Promise<LocalBridgePairingRequest> {
  return {
    version: 1,
    origin,
    accountID,
    state,
    challenge: await localBridgeChallenge(verifier),
  }
}

function entropy() {
  let value = 10
  return (length: number) => new Uint8Array(length).fill(++value)
}

async function sidecar(
  handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ok: true }))
  },
) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("sidecar address missing")
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  cleanup.push(close)
  return { server, url: `http://127.0.0.1:${address.port}`, close }
}

async function setup() {
  const target = await sidecar()
  const gateway = createLocalBridgeGateway({
    sidecar: async () => ({ url: target.url, username: "mongolgpt", password: "sidecar-secret" }),
    randomBytes: entropy(),
  })
  cleanup.push(() => gateway.stop())
  const authorization = await gateway.authorize(await pairing())
  return { target, gateway, authorization, base: `http://127.0.0.1:${authorization.port}` }
}

async function exchange(base: string, code: string, nextVerifier = verifier, requestOrigin = origin) {
  return fetch(`${base}/bridge/v1/session`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify({ code, verifier: nextVerifier }),
  })
}

function basic(token: string) {
  return `Basic ${Buffer.from(`bridge:${token}`).toString("base64")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function jsonRecord(response: Response) {
  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error("JSON object expected")
  return value
}

async function sessionToken(response: Response) {
  const value = await jsonRecord(response)
  if (typeof value.token !== "string") throw new Error("Session token expected")
  return value.token
}

describe("desktop local bridge gateway", () => {
  test("exchanges a pairing code once and binds the session to its origin", async () => {
    const { authorization, base } = await setup()
    const response = await exchange(base, authorization.code)
    const body = await jsonRecord(response)

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body).toMatchObject({ authenticated: true, username: "bridge", accountID })
    expect(typeof body.token).toBe("string")
    expect(String(body.token)).not.toBe(authorization.code)

    expect((await exchange(base, authorization.code)).status).toBe(401)
    expect((await exchange(base, authorization.code, verifier, "https://attacker.example")).status).toBe(403)
  })

  test("consumes a pairing code after one invalid verifier attempt", async () => {
    const { authorization, base } = await setup()
    expect((await exchange(base, authorization.code, state)).status).toBe(401)
    expect((await exchange(base, authorization.code)).status).toBe(403)
  })

  test("supports a strict private-network CORS preflight only for the paired origin", async () => {
    const { base } = await setup()
    const accepted = await fetch(`${base}/bridge/v1/session`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
        "access-control-request-private-network": "true",
      },
    })
    expect(accepted.status).toBe(204)
    expect(accepted.headers.get("access-control-allow-private-network")).toBe("true")
    expect(accepted.headers.get("access-control-allow-origin")).toBe(origin)
    expect(accepted.headers.get("access-control-allow-headers")).toContain("authorization")

    const smuggled = await fetch(`${base}/bridge/v1/session`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-attacker-header",
      },
    })
    expect(smuggled.status).toBe(403)
  })

  test("proxies an authenticated request without exposing browser or sidecar credentials", async () => {
    let observed:
      | { url: string | undefined; authorization: string | undefined; origin: string | undefined; body: string }
      | undefined
    const target = await sidecar(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observed = {
        url: request.url,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        body: Buffer.concat(chunks).toString("utf8"),
      }
      response.setHeader("content-type", "application/json")
      response.setHeader("set-cookie", "sidecar=must-not-leak")
      response.setHeader("location", "https://attacker.example")
      response.end(JSON.stringify({ proxied: true }))
    })
    const gateway = createLocalBridgeGateway({
      sidecar: async () => ({ url: target.url, username: "mongolgpt", password: "sidecar-secret" }),
      randomBytes: entropy(),
    })
    cleanup.push(() => gateway.stop())
    const authorization = await gateway.authorize(await pairing())
    const base = `http://127.0.0.1:${authorization.port}`
    const token = await sessionToken(await exchange(base, authorization.code))

    const response = await fetch(`${base}/session/test?value=1`, {
      method: "POST",
      headers: {
        origin,
        authorization: basic(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ proxied: true })
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    expect(observed).toEqual({
      url: "/session/test?value=1",
      authorization: `Basic ${Buffer.from("mongolgpt:sidecar-secret").toString("base64")}`,
      origin: undefined,
      body: JSON.stringify({ hello: "world" }),
    })

    expect(
      (
        await fetch(`${base}/session/test`, {
          headers: { origin: "https://attacker.example", authorization: basic(token) },
        })
      ).status,
    ).toBe(403)
  })

  test("revokes browser sessions and closes permanently after a startup race", async () => {
    const { gateway, authorization, base } = await setup()
    const token = await sessionToken(await exchange(base, authorization.code))
    gateway.revokeAll()
    expect(
      (
        await fetch(`${base}/session/test`, {
          headers: { origin, authorization: basic(token) },
        })
      ).status,
    ).toBe(403)

    const target = await sidecar()
    const racing = createLocalBridgeGateway({
      sidecar: async () => ({ url: target.url, username: "mongolgpt", password: "sidecar-secret" }),
      randomBytes: entropy(),
    })
    const authorizationPromise = racing.authorize(await pairing())
    const authorizationResult = authorizationPromise.catch((error: unknown) => error)
    await racing.stop()
    expect(await authorizationResult).toBeInstanceOf(Error)
    await expect(racing.authorize(await pairing())).rejects.toThrow()
  })

  test("bounds concurrent buffered proxy requests per gateway", async () => {
    const target = await sidecar()
    const pending: Array<(response: Response) => void> = []
    let releaseReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => (releaseReady = resolve))
    const gateway = createLocalBridgeGateway({
      sidecar: async () => ({ url: target.url, username: "mongolgpt", password: "sidecar-secret" }),
      randomBytes: entropy(),
      fetch: () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve)
          if (pending.length === 8) releaseReady?.()
        }),
    })
    cleanup.push(() => gateway.stop())
    const authorization = await gateway.authorize(await pairing())
    const base = `http://127.0.0.1:${authorization.port}`
    const token = await sessionToken(await exchange(base, authorization.code))
    const requests = Array.from({ length: 8 }, (_, index) =>
      fetch(`${base}/hold/${index}`, { headers: { origin, authorization: basic(token) } }),
    )
    await ready

    const limited = await fetch(`${base}/hold/limited`, {
      headers: { origin, authorization: basic(token) },
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("1")

    for (const resolve of pending) {
      resolve(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }))
    }
    expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true)
  })

  test("rejects credential-bearing WebSocket URLs and proxies only one-time PTY tickets", async () => {
    const result = await nodeWebSocketCheck()
    expect(result).toEqual({
      rejected: 401,
      accepted: 101,
      replayed: 403,
      revoked: true,
      upstreamOrigin: "mongolgpt-renderer://renderer",
    })
  })
})

function nodeWebSocketCheck() {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn("node", [fileURLToPath(new URL("./local-bridge-gateway.node-check.ts", import.meta.url))], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error("Node WebSocket bridge шалгалтын хугацаа дууслаа"))
    }, 5_000)
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(
          new Error(Buffer.concat(stderr).toString("utf8") || `Node WebSocket bridge шалгалт ${code} кодоор зогслоо`),
        )
        return
      }
      try {
        const value: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"))
        if (!isRecord(value)) throw new Error("JSON object expected")
        resolve(value)
      } catch (error) {
        reject(error)
      }
    })
  })
}
