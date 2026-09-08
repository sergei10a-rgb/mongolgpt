export * as RuntimeSupervisor from "./runtime-supervisor"

import { chown, lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Duplex } from "node:stream"
import { CloudStartup } from "./database/cloud-startup"
import { StartupHandoff } from "./database/startup-handoff"
import { ProcessGroup } from "./process-group"
import { RuntimeControl } from "./runtime-control"
import type { CloudFiles } from "./database/cloud-files"

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
    let checkpoint = await CloudStartup.bootstrap({ root, request: input.request, signal: input.signal })
    if (!checkpoint) {
      const { CloudBaseline } = await import("./database/cloud-baseline")
      const created = await CloudBaseline.publish({ root, request: input.request, signal: input.signal })
      checkpoint = await CloudStartup.bootstrap({ root, request: input.request, signal: input.signal })
      if (checkpoint?.id !== created.id) throw new CloudBaseline.BaselineError()
    }
    const checkpointID = checkpoint?.id
    await own(root, uid, input.signal)
    input.signal?.throwIfAborted()
    const packet = await StartupHandoff.issue({ root, group: group.directory, checkpoint })
    try {
      const child = await group.spawn({
        executable: input.executable,
        args: input.args,
        cwd: root,
        env: { ...input.env, MONGOLGPT_RUNTIME_PREPARED_FD: "4", MONGOLGPT_RUNTIME_CONTROL_FD: "5:6" },
        startupFD: packet.fd,
        controlChannel: true,
        stdio: input.stdio ?? "pipe",
      })
      input.signal?.throwIfAborted()
      async function publishFiles(lease: CloudFiles.Lease, signal?: AbortSignal) {
        const owner = { ...lease }
        const { CloudFiles } = await import("./database/cloud-files")
        try {
          if (!checkpointID) throw new CloudFiles.PublicationError()
          return await group.quiesce(
            (signal) =>
              CloudFiles.publish({
                root,
                checkpointID,
                lease: owner,
                signal,
                request: input.request,
              }),
            { signal, closeOnError: true },
          )
        } catch (error) {
          // Unknown remote acknowledgement fences this process, never a success
          // response or a new blind snapshot against possibly advanced state.
          await group.close()
          throw error
        }
      }
      const responses = child.stdio.at(5)
      const requests = child.stdio.at(6)
      if (!(responses instanceof Duplex) || !(requests instanceof Duplex)) throw new ProcessGroup.IsolationError()
      const channel = Duplex.from({ readable: requests, writable: responses })
      // Bun's composed Duplex does not close both underlying pipe handles.
      // Own them explicitly so child "close" cannot wait forever after exit.
      const disconnect = () => {
        requests.destroy()
        responses.destroy()
        channel.destroy()
      }
      child.once("exit", disconnect)
      child.once("error", disconnect)
      const control = RuntimeControl.serve(channel, {
        publish: publishFiles,
        async close() {
          try {
            await group.close()
          } finally {
            disconnect()
          }
        },
      }).finally(() => {
        child.removeListener("exit", disconnect)
        child.removeListener("error", disconnect)
      })
      // The CLI owns the terminal outcome; tests may exercise the group directly.
      void control.catch(() => {})
      return { child, group, checkpoint, publishFiles, control }
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
