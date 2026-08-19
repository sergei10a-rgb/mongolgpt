import { access } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const mainDirectory = path.resolve(import.meta.dirname, "../out/main")
const serverEntry = path.join(mainDirectory, "server/node.js")

await Promise.all([
  access(path.join(mainDirectory, "index.js")),
  access(path.join(mainDirectory, "sidecar.js")),
  access(serverEntry),
])

const server = (await import(pathToFileURL(serverEntry).href)) as Record<string, unknown>
if (typeof server.configureAccountTokenEncryptionKey !== "function") {
  throw new Error("Packaged server bundle account token encryption export-гүй байна")
}
if (typeof server.Server !== "object" || server.Server === null) {
  throw new Error("Packaged server bundle Server export-гүй байна")
}

console.log("Desktop server bundle smoke test passed")
