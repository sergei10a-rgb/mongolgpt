import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { connect, type Socket } from "node:net"
import { localBridgeChallenge } from "@mongolgpt/local-bridge"
// Node's built-in TypeScript loader requires the explicit extension.
// @ts-expect-error TS5097
import { createLocalBridgeGateway } from "./local-bridge-gateway.ts"

const origin = "https://app.dev.mgpt.mn"
const verifier = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

function entropy() {
  let value = 30
  return (length: number) => new Uint8Array(length).fill(++value)
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Sidecar port олдсонгүй")
  return address.port
}

async function close(server: Server, sockets: Iterable<Socket> = []) {
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function openUpgrade(port: number, path: string, headers: string[] = []) {
  return new Promise<{ response: string; socket: ReturnType<typeof connect> }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`WebSocket upgrade хугацаа дууслаа: ${path}`))
    }, 2_000)
    let response = ""
    let settled = false
    socket.once("error", (error) => {
      if (!settled) reject(error)
    })
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8")
      if (settled || !response.includes("\r\n\r\n")) return
      settled = true
      clearTimeout(timeout)
      resolve({ response, socket })
    })
    socket.once("end", () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (response) resolve({ response, socket })
      else reject(new Error(`WebSocket upgrade хоосон хариу буцаалаа: ${path}`))
    })
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Origin: ${origin}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
          "",
          "",
        ].join("\r\n"),
      )
    })
  })
}

async function rawUpgrade(port: number, path: string, headers: string[] = []) {
  const result = await openUpgrade(port, path, headers)
  result.socket.destroy()
  return result.response
}

const sidecar = createServer((_request, response) => response.end())
const sidecarSockets = new Set<Socket>()
sidecar.on("connection", (socket) => {
  sidecarSockets.add(socket)
  socket.once("close", () => sidecarSockets.delete(socket))
})
let upstreamOrigin: string | undefined
let spoofedForwardingHeader: string | undefined
const tickets = new Set(["one-time-ticket", "revocation-ticket"])
sidecar.on("upgrade", (request, socket) => {
  upstreamOrigin = request.headers.origin
  const forwarded = request.headers["x-forwarded-for"]
  spoofedForwardingHeader = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const ticket = new URL(request.url ?? "/", "http://localhost").searchParams.get("ticket")
  if (!ticket || !tickets.delete(ticket)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    return
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
})

const sidecarPort = await listen(sidecar)
const gateway = createLocalBridgeGateway({
  sidecar: async () => ({
    url: `http://127.0.0.1:${sidecarPort}`,
    username: "mongolgpt",
    password: "sidecar-secret",
  }),
  randomBytes: entropy(),
})

try {
  const challenge = await localBridgeChallenge(verifier)
  const authorization = await gateway.authorize({
    version: 1,
    origin,
    accountID: "usr_local_bridge",
    state: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
    challenge,
  })
  const exchange = await fetch(`http://127.0.0.1:${authorization.port}/bridge/v1/session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code: authorization.code, verifier }),
  })
  assert.equal(exchange.status, 200)

  const rejected = await rawUpgrade(authorization.port, "/pty/pty-1/connect?auth_token=secret")
  const accepted = await rawUpgrade(authorization.port, "/pty/pty-1/connect?ticket=one-time-ticket")
  const replayed = await rawUpgrade(authorization.port, "/pty/pty-1/connect?ticket=one-time-ticket")
  const active = await openUpgrade(authorization.port, "/pty/pty-1/connect?ticket=revocation-ticket", [
    "X-Forwarded-For: 203.0.113.9",
  ])
  assert.match(rejected, /^HTTP\/1\.1 401/)
  assert.match(accepted, /^HTTP\/1\.1 101/)
  assert.match(replayed, /^HTTP\/1\.1 403/)
  assert.match(active.response, /^HTTP\/1\.1 101/)
  assert.equal(upstreamOrigin, "mongolgpt-renderer://renderer")
  assert.equal(spoofedForwardingHeader, undefined)
  const revoked = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Нээлттэй WebSocket хүчингүй болсонгүй")), 2_000)
    active.socket.once("close", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  gateway.revokeAll()
  await revoked
  console.log(JSON.stringify({ rejected: 401, accepted: 101, replayed: 403, revoked: true, upstreamOrigin }))
} finally {
  await gateway.stop()
  await close(sidecar, sidecarSockets)
}
