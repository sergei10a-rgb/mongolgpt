export * as RuntimeSupervisor from "./runtime-supervisor"

import { chown, lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Duplex } from "node:stream"
import { CloudStartup } from "./database/cloud-startup"
import { StartupHandoff } from "./database/startup-handoff"
import { ProcessGroup } from "./process-group"
import { RuntimeControl } from "./runtime-control"
import { RuntimeLock } from "./runtime-lock"
import { RuntimeState } from "./runtime-state"
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
  stderr?: "pipe"
  checkpointIntervalMs?: number
}) {
  input = { ...input, args: [...input.args], env: { ...input.env } }
  const checkpointIntervalMs = input.checkpointIntervalMs ?? 300_000
  if (!Number.isSafeInteger(checkpointIntervalMs) || checkpointIntervalMs < 1000 || checkpointIntervalMs > 3_600_000)
    throw new ProcessGroup.IsolationError()
  let timer: ReturnType<typeof setTimeout> | undefined
  let schedulingStopped = false
  function stopScheduling() {
    schedulingStopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const root = resolve(input.root)
  const uid = 10001
  const lock = await RuntimeLock.acquire({ root, launcher: input.launcher, signal: input.signal })
  let group: Awaited<ReturnType<typeof ProcessGroup.create>> | undefined
  try {
    const state = await RuntimeState.openState(lock.directory, root)
    const previous = await state.read()
    if (previous) await ProcessGroup.reap(previous.group)
    const createdGroup = await ProcessGroup.create({ launcher: input.launcher, uid, gid: uid })
    const ownedGroup = {
      ...createdGroup,
      async close() {
        stopScheduling()
        await createdGroup.close()
        await lock.close()
      },
    }
    group = ownedGroup
    // Legacy records did not persist claim intent: their unknown outcome cannot
    // be treated as permission to choose a new writer or discard native state.
    if (previous?.version === 1 && previous.epoch === undefined) throw new RuntimeState.StateError()
    let checkpoint = previous
      ? await CloudStartup.resume({
          root,
          request: input.request,
          signal: input.signal,
          checkpointID: previous.checkpointID,
          expectedEpoch: previous.epoch,
        })
      : await CloudStartup.bootstrap({ root, request: input.request, signal: input.signal })
    if (!checkpoint) {
      const { CloudBaseline } = await import("./database/cloud-baseline")
      const created = await CloudBaseline.publish({ root, request: input.request, signal: input.signal })
      checkpoint = await CloudStartup.bootstrap({ root, request: input.request, signal: input.signal })
      if (checkpoint?.id !== created.id) throw new CloudBaseline.BaselineError()
    }
    const checkpointID = checkpoint?.id
    if (previous?.pendingClaim) {
      if (checkpoint.filesRevisionID !== previous.pendingClaim.filesRevisionID) throw new RuntimeState.StateError()
      checkpoint.pendingClaim = {
        expectedEpoch: previous.pendingClaim.expectedEpoch,
        writerID: previous.pendingClaim.writerID,
      }
    }
    if (!previous) await own(root, uid, input.signal)
    let pendingClaim = previous?.pendingClaim
    await state.write({
      checkpointID: checkpoint.id,
      group: ownedGroup.directory,
      ...(previous?.epoch ? { epoch: previous.epoch } : {}),
      ...(pendingClaim ? { pendingClaim } : {}),
    })
    input.signal?.throwIfAborted()
    const packet = await StartupHandoff.issue({ root, group: ownedGroup.directory, checkpoint })
    try {
      const child = await ownedGroup.spawn({
        executable: input.executable,
        args: input.args,
        cwd: root,
        env: { ...input.env, MONGOLGPT_RUNTIME_PREPARED_FD: "4", MONGOLGPT_RUNTIME_CONTROL_FD: "5:6" },
        startupFD: packet.fd,
        controlChannel: true,
        stdio: input.stdio ?? "pipe",
        stderr: input.stderr,
      })
      input.signal?.throwIfAborted()
      let registeredLease: CloudFiles.Lease | undefined
      let stopping: Promise<void> | undefined
      async function publishFiles(lease: CloudFiles.Lease, signal?: AbortSignal) {
        const owner = { ...lease }
        const { CloudFiles } = await import("./database/cloud-files")
        try {
          if (!checkpointID) throw new CloudFiles.PublicationError()
          return await ownedGroup.quiesce(
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
          await ownedGroup.close()
          throw error
        }
      }
      function stop(signal?: AbortSignal) {
        if (stopping) return stopping
        stopScheduling()
        stopping = (async () => {
          try {
            const { CloudFiles } = await import("./database/cloud-files")
            if (!registeredLease || !checkpointID) throw new CloudFiles.PublicationError()
            const lease = { ...registeredLease }
            await ownedGroup.quiesce(
              (signal) => CloudFiles.publish({ root, checkpointID, lease, signal, request: input.request }),
              { signal, closeOnSuccess: true },
            )
          } finally {
            // The final freezer operation closes the cgroup; this also releases
            // the supervisor lock, including when publication was uncertain.
            await ownedGroup.close()
          }
        })()
        return stopping
      }
      function scheduleCheckpoint() {
        if (schedulingStopped || timer) return
        timer = setTimeout(() => {
          timer = undefined
          if (schedulingStopped || !registeredLease) return
          // Schedule from settlement, not from a fixed interval: slow captures
          // never accumulate queued work or overlap another background capture.
          void publishFiles(registeredLease).then(scheduleCheckpoint, stopScheduling)
        }, checkpointIntervalMs)
        timer.unref()
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
        async prepare(claim, signal) {
          if (
            (previous?.epoch !== undefined && claim.expectedEpoch !== previous.epoch) ||
            (pendingClaim &&
              (claim.expectedEpoch !== pendingClaim.expectedEpoch || claim.writerID !== pendingClaim.writerID))
          )
            throw new RuntimeState.StateError()
          const intent = {
            ...claim,
            ...(checkpoint.filesRevisionID ? { filesRevisionID: checkpoint.filesRevisionID } : {}),
          }
          await ownedGroup.quiesce(
            () =>
              state.write({
                checkpointID: checkpoint.id,
                group: ownedGroup.directory,
                ...(previous?.epoch ? { epoch: previous.epoch } : {}),
                pendingClaim: intent,
              }),
            { signal, closeOnError: true },
          )
          pendingClaim = intent
        },
        async register(lease, signal) {
          if (
            !pendingClaim ||
            lease.epoch !== pendingClaim.expectedEpoch + 1 ||
            lease.writerID !== pendingClaim.writerID
          )
            return Promise.reject(new RuntimeState.StateError())
          await ownedGroup.quiesce(
            () => state.write({ checkpointID: checkpoint.id, group: ownedGroup.directory, epoch: lease.epoch }),
            { signal, closeOnError: true },
          )
          registeredLease = { ...lease }
          pendingClaim = undefined
          scheduleCheckpoint()
        },
        publish: publishFiles,
        async close() {
          try {
            await ownedGroup.close()
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
      return { child, group: ownedGroup, checkpoint, publishFiles, stop, control }
    } finally {
      await packet.close()
    }
  } catch (error) {
    await group?.close()
    await lock.close()
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
