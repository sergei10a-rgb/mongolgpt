export * as CloudWorkspace from "./cloud-workspace"

import { createReadStream, createWriteStream, fstatSync } from "node:fs"
import { Duplex } from "node:stream"
import { RuntimeControl } from "../runtime-control"
import { CloudStartup } from "./cloud-startup"

let client: RuntimeControl.Client | undefined

export function connect() {
  if (!CloudStartup.supervised()) throw new Error("Cloud хадгалалтын хяналтын процесс баталгаажаагүй байна.")
  if (client) return client
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 10001 ||
    process.env.MONGOLGPT_RUNTIME_CONTROL_FD !== "5:6"
  )
    throw new Error("Cloud хадгалалтын хамгаалагдсан суваг алга байна.")
  if (!fstatSync(5).isSocket() || !fstatSync(6).isSocket()) throw new Error("Cloud хадгалалтын суваг буруу байна.")
  delete process.env.MONGOLGPT_RUNTIME_CONTROL_FD
  // Separate directions allow writer close to wake the peer before cancelling
  // an outstanding native read. Bun cannot adopt an existing fd via net.Socket.
  client = RuntimeControl.create(
    Duplex.from({
      readable: createReadStream("", { fd: 5, autoClose: true }),
      writable: createWriteStream("", { fd: 6, autoClose: true }),
    }),
  )
  return client
}

/** Local mode keeps its existing filesystem behavior. Hosted writers use the
 * same supervisor channel and lease registered by cloud history recovery. */
export function publish(signal?: AbortSignal) {
  if (process.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE !== "true") return Promise.resolve()
  if (!CloudStartup.supervised()) return Promise.resolve()
  return connect().publish(signal)
}
