export * as CloudWorkspace from "./cloud-workspace"

import { fstatSync } from "node:fs"
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
  client = RuntimeControl.inherit({ readFD: 5, writeFD: 6 })
  return client
}

/** Local mode keeps its existing filesystem behavior. Hosted writers use the
 * same supervisor channel and lease registered by cloud history recovery. */
export function publish(signal?: AbortSignal) {
  if (process.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE !== "true") return Promise.resolve()
  if (!CloudStartup.supervised()) return Promise.resolve()
  return connect().publish(signal)
}
