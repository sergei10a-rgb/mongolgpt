import { createHash, randomUUID } from "node:crypto"
import type { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"

/** Transport fixture only. Runtime integration separately uses real D1/R2. */
export function cloudBaselineStore() {
  const key = Buffer.alloc(32, 7).toString("base64")
  const archives = new Map<string, Uint8Array>()
  const calls: string[] = []
  let checkpoint: CloudCheckpoint.Checkpoint | undefined
  let filesRevision: CloudCheckpoint.FileRevision | undefined
  return {
    calls,
    archives,
    get checkpoint() {
      return checkpoint
    },
    get filesRevision() {
      return filesRevision
    },
    async request(request: Request): Promise<Response> {
      const route = new URL(request.url).pathname
      calls.push(route)
      if (route === "/v1/bootstrap")
        return Response.json(
          checkpoint
            ? { checkpoint, ...(filesRevision ? { filesRevision } : {}), keys: { sqlite: key, files: key } }
            : { checkpoint: null },
        )
      if (route === "/v1/begin") {
        const input = (await request.json()) as { writerID: string }
        return Response.json({ lease: { epoch: 1, writerID: input.writerID }, keyID: "synthetic", key })
      }
      if (route === "/v1/upload") {
        const bytes = new Uint8Array(await request.arrayBuffer())
        const backupID = randomUUID()
        archives.set(backupID, bytes)
        return Response.json({
          backupID,
          keyID: "synthetic",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      }
      if (route === "/v1/publish") {
        const input = (await request.json()) as { checkpoint: CloudCheckpoint.Checkpoint }
        checkpoint = input.checkpoint
        return Response.json({ data: checkpoint, digest: "a".repeat(64) })
      }
      if (route === "/v1/archive") {
        const input = (await request.json()) as { kind: "sqlite" | "files" }
        const archive =
          input.kind === "files"
            ? (filesRevision?.archive ?? checkpoint!.files)
            : (filesRevision?.sqlite ?? checkpoint!.sqlite)
        const bytes = archives.get(archive.backupID)!
        return new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
          },
        })
      }
      if (route === "/v1/publish-files") {
        filesRevision = ((await request.json()) as { revision: CloudCheckpoint.FileRevision }).revision
        return Response.json({ data: filesRevision, digest: "a".repeat(64) })
      }
      throw new Error(`Unexpected fixture route: ${route}`)
    },
  }
}
