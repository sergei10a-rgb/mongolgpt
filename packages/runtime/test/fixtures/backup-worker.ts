import { createRuntimeBackupStore, deriveRuntimeBackupKey, RuntimeBackupError } from "../../src/backup"

// Synthetic keys in a loopback-only test fixture. Never deploy this handler.
const scope = { accountID: "acc_worker", workspaceID: "wrk_worker" }
const keyID = "key_worker"
const master = bytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")

export default {
  async fetch(request: Request, env: { BACKUPS: R2Bucket }) {
    const url = new URL(request.url)
    const store = createRuntimeBackupStore(env.BACKUPS)
    try {
      if (request.method === "GET" && url.pathname === "/derive") {
        return Response.json({ key: hex(deriveRuntimeBackupKey(scope, keyID, master)) })
      }
      if (request.method === "POST" && url.pathname === "/backup") {
        if (!request.body) return new Response("missing body", { status: 400 })
        const manifest = await store.save(scope, { keyID, body: request.body })
        return Response.json({ manifest, key: hex(deriveRuntimeBackupKey(scope, keyID, master)) })
      }
      if (request.method === "GET" && url.pathname.startsWith("/backup/")) {
        const opened = await store.open(scope, url.pathname.slice("/backup/".length))
        return new Response(opened.body, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/octet-stream",
            "x-backup-manifest": JSON.stringify(opened.manifest),
          },
        })
      }
      return new Response("not found", { status: 404 })
    } catch (error) {
      if (error instanceof RuntimeBackupError) {
        return Response.json(
          { code: error.code, message: error.message },
          { status: { invalid: 400, not_found: 404, unavailable: 503 }[error.code] },
        )
      }
      return Response.json({ code: "unavailable" }, { status: 503 })
    }
  },
}

function bytes(input: string) {
  return Uint8Array.from(
    Array.from({ length: input.length / 2 }, (_, index) => Number.parseInt(input.slice(index * 2, index * 2 + 2), 16)),
  )
}

function hex(input: Uint8Array) {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
