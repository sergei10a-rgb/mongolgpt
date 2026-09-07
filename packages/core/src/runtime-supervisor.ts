export * as RuntimeSupervisor from "./runtime-supervisor"

import { chown, lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { CloudStartup } from "./database/cloud-startup"
import { StartupHandoff } from "./database/startup-handoff"
import { ProcessGroup } from "./process-group"

/** Bootstrap stays privileged and outside the frozen group. No workspace code
 * executes until authenticated restore and ownership transfer have completed. */
export async function start(input: {
  root: string
  launcher: string
  executable: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  request?: (request: Request) => Promise<Response>
  signal?: AbortSignal
  stdio?: "pipe" | "inherit"
}) {
  input = { ...input, args: [...input.args], env: { ...input.env } }
  const root = resolve(input.root)
  const uid = 10001
  const group = await ProcessGroup.create({ launcher: input.launcher, uid, gid: uid })
  try {
    const checkpoint = await CloudStartup.bootstrap({ root, request: input.request, signal: input.signal })
    await own(root, uid, input.signal)
    input.signal?.throwIfAborted()
    const packet = await StartupHandoff.issue({ root, group: group.directory, checkpoint })
    try {
      const child = await group.spawn({
        executable: input.executable,
        args: input.args,
        cwd: root,
        env: { ...input.env, MONGOLGPT_RUNTIME_PREPARED_FD: "4" },
        startupFD: packet.fd,
        stdio: input.stdio ?? "pipe",
      })
      input.signal?.throwIfAborted()
      return { child, group, checkpoint }
    } finally {
      await packet.close()
    }
  } catch (error) {
    await group.close()
    throw error
  }
}

async function own(root: string, uid: number, signal?: AbortSignal) {
  const pending = [root]
  let entries = 0
  while (pending.length) {
    signal?.throwIfAborted()
    if (++entries > 20_000) throw new ProcessGroup.IsolationError()
    const path = pending.pop()!
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new ProcessGroup.IsolationError()
    if (info.isDirectory()) for (const name of await readdir(path)) pending.push(join(path, name))
    await chown(path, uid, uid)
  }
}
