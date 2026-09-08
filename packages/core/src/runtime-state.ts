export * as RuntimeState from "./runtime-state"

import { constants } from "node:fs"
import { lstat, open, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { Schema } from "effect"

const State = Schema.Struct({
  version: Schema.Literal(1),
  root: Schema.String,
  checkpointID: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  ),
  group: Schema.String.check(Schema.isPattern(/^\/sys\/fs\/cgroup\/mongolgpt-[0-9a-f-]{36}$/)),
  epoch: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER))),
})
export type State = typeof State.Type

export class StateError extends Error {
  constructor() {
    super("Cloud төслийн өмнөх ажиллах төлөвийг баталгаажуулж чадсангүй.")
    this.name = "RuntimeStateError"
  }
}

/** The directory is provided by RuntimeLock, never by tenant input. Keep that
 * lock held across read, orphan cleanup, every update and the complete lifetime. */
export async function openState(directory: string, root: string) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || resolve(root) !== root) throw new StateError()
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o777) !== 0o700)
    throw new StateError()
  const filename = join(directory, "state.json")
  return {
    async read() {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw new StateError()
        },
      )
      if (!file) return undefined
      try {
        const info = await file.stat()
        if (
          !info.isFile() ||
          info.uid !== 0 ||
          info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 ||
          info.size < 1 ||
          info.size > 4096
        )
          throw new StateError()
        const data = Schema.decodeUnknownSync(State)(
          Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await file.readFile("utf8")),
          { onExcessProperty: "error" },
        )
        if (data.root !== root) throw new StateError()
        return data
      } catch {
        throw new StateError()
      } finally {
        await file.close()
      }
    },
    async write(input: Omit<State, "version" | "root">) {
      const data = Schema.decodeUnknownSync(State)({ ...input, version: 1, root }, { onExcessProperty: "error" })
      const bytes = Buffer.from(JSON.stringify(data))
      if (bytes.length > 4096) throw new StateError()
      const temporary = join(directory, `state-${randomUUID()}.tmp`)
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await file.writeFile(bytes)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, filename)
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      } finally {
        bytes.fill(0)
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw new StateError()
        })
      }
    },
  }
}
