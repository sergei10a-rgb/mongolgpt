export * as StartupHandoff from "./startup-handoff"

import { closeSync, fstatSync, readSync } from "node:fs"
import { lstat, mkdtemp, open, readFile, rmdir, unlink } from "node:fs/promises"
import { join, posix, resolve } from "node:path"
import { Schema } from "effect"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import type { CloudStartup } from "./cloud-startup"
import { RuntimeControl } from "../runtime-control"
import { startupHandoffCodes } from "@mongolgpt/runtime-auth/startup-diagnostic"

type HandoffCode = (typeof startupHandoffCodes)[number]

const maxBytes = 1024 * 1024
const UUID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const Packet = Schema.Struct({
  version: Schema.Literal(1),
  root: Schema.String,
  group: Schema.String,
  checkpoint: Schema.Union([
    Schema.Null,
    Schema.Struct({
      data: CloudCheckpoint.Checkpoint,
      filesRevisionID: Schema.optional(UUID),
      pendingClaim: Schema.optional(RuntimeControl.Claim),
      resume: Schema.optional(
        Schema.Struct({
          expectedEpoch: Schema.optional(
            Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER)),
          ),
        }),
      ),
    }),
  ]),
})

export class HandoffError extends Error {
  constructor(readonly code: HandoffCode = "handoff_unknown") {
    super("Cloud серверт сэргээсэн төлөвийг найдвартай дамжуулж чадсангүй.")
    this.name = "StartupHandoffError"
  }
}

/** Root supervisor only. The packet has no encryption keys. It is unlinked
 * before launch and inherited as a read-only fd, not a tenant-writable path. */
export async function issue(input: { root: string; group: string; checkpoint: CloudStartup.Baseline | null }) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new HandoffError()
  const root = resolve(input.root)
  const group = input.group
  if (root !== input.root || !/^\/sys\/fs\/cgroup\/(?:[A-Za-z0-9_.-]+\/)*mongolgpt-[0-9a-f-]{36}$/.test(group))
    throw new HandoffError()
  const checkpoint = input.checkpoint
  const packet = {
    version: 1,
    root,
    group: cgroupMembership(group, await readFile("/proc/self/mountinfo", "utf8")),
    checkpoint: checkpoint
      ? {
          data: {
            id: checkpoint.id,
            inventory: checkpoint.inventory,
            sqlite: checkpoint.sqlite,
            files: checkpoint.files,
          },
          ...(checkpoint.filesRevisionID ? { filesRevisionID: checkpoint.filesRevisionID } : {}),
          ...(checkpoint.pendingClaim ? { pendingClaim: checkpoint.pendingClaim } : {}),
          ...(checkpoint.resume ? { resume: checkpoint.resume } : {}),
        }
      : null,
  }
  const decoded = Schema.decodeUnknownSync(Packet)(packet, { onExcessProperty: "error" })
  const bytes = Buffer.from(JSON.stringify(decoded))
  if (bytes.length > maxBytes) throw new HandoffError()
  const parent = await lstat("/run")
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
    throw new HandoffError()
  const directory = await mkdtemp("/run/mongolgpt-startup-")
  const path = join(directory, "packet")
  try {
    const writer = await open(path, "wx", 0o600)
    try {
      await writer.writeFile(bytes)
      await writer.sync()
    } finally {
      await writer.close()
    }
    const reader = await open(path, "r")
    try {
      await unlink(path)
      await rmdir(directory)
      return reader
    } catch (error) {
      await reader.close()
      throw error
    }
  } finally {
    bytes.fill(0)
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

/** Mount roots, unlike mount points, use the same cgroup namespace as /proc/self/cgroup. */
export function cgroupMembership(group: string, mountinfo: string) {
  if (
    posix.resolve(group) !== group ||
    !/^\/sys\/fs\/cgroup\/(?:[A-Za-z0-9_.-]+\/)*mongolgpt-[0-9a-f-]{36}$/.test(group) ||
    mountinfo.length > maxBytes
  )
    throw new HandoffError()
  const mounts = mountinfo
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ")
      const separator = fields.indexOf("-")
      if (
        separator < 6 ||
        fields.length !== separator + 4 ||
        !/^\d+$/.test(fields[0]) ||
        !/^\d+$/.test(fields[1]) ||
        !/^\d+:\d+$/.test(fields[2]) ||
        !fields[3].startsWith("/") ||
        !fields[4].startsWith("/")
      )
        throw new HandoffError()
      return { id: fields[0], parent: fields[1], root: fields[3], point: fields[4], type: fields[separator + 1] }
    })
    .filter((mount) => group === mount.point || group.startsWith(mount.point === "/" ? "/" : `${mount.point}/`))
    .sort((left, right) => right.point.length - left.point.length)
  // Reject ambiguous stacks; never infer identity by a matching path suffix.
  const candidates = mounts.filter((mount) => mount.point === mounts[0]?.point)
  const top = candidates.filter((mount) => !candidates.some((other) => other.parent === mount.id && other !== mount))
  if (top.length !== 1 || top[0].type !== "cgroup2") throw new HandoffError()
  const path = `${top[0].root === "/" ? "" : top[0].root}${group.slice(top[0].point.length)}`
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*mongolgpt-[0-9a-f-]{36}$/.test(path)) throw new HandoffError()
  return path
}

/** fd 4 is reserved for the root supervisor's startup receipt and consumed once.
 * An ordinary CLI/env flag cannot synthesize a root-owned anonymous receipt. */
export async function accept(root: string): Promise<CloudStartup.Baseline | null> {
  if (process.platform !== "linux" || !process.getuid?.() || process.env.MONGOLGPT_RUNTIME_PREPARED_FD !== "4")
    throw new HandoffError("handoff_identity")
  let bytes: Buffer | undefined
  let code: HandoffCode = "handoff_fd_stat"
  try {
    const info = fstatSync(4)
    code = "handoff_fd_type"
    if (!info.isFile()) throw new HandoffError(code)
    code = "handoff_fd_owner"
    if (info.uid !== 0) throw new HandoffError(code)
    code = "handoff_fd_links"
    if (info.nlink !== 0) throw new HandoffError(code)
    code = "handoff_fd_mode"
    if ((info.mode & 0o777) !== 0o600) throw new HandoffError(code)
    code = "handoff_fd_size"
    if (info.size < 1 || info.size > maxBytes) throw new HandoffError(code)
    code = "handoff_read"
    bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(4, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new HandoffError(code)
      offset += count
    }
    const after = fstatSync(4)
    code = "handoff_changed"
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs)
      throw new HandoffError(code)
    code = "handoff_decode"
    const packet = Schema.decodeUnknownSync(Packet)(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(bytes.toString("utf8")),
      { onExcessProperty: "error" },
    )
    code = "handoff_root"
    if (packet.root !== root || resolve(root) !== root) throw new HandoffError(code)
    code = "handoff_group"
    if (!/^\/(?:[A-Za-z0-9_.-]+\/)*mongolgpt-[0-9a-f-]{36}$/.test(packet.group)) throw new HandoffError(code)
    code = "handoff_cgroup_read"
    const membership = (await readFile("/proc/self/cgroup", "utf8")).trim()
    code = "handoff_cgroup_binding"
    if (membership !== `0::${packet.group}`) throw new HandoffError(code)
    return packet.checkpoint
      ? {
          ...packet.checkpoint.data,
          ...(packet.checkpoint.filesRevisionID ? { filesRevisionID: packet.checkpoint.filesRevisionID } : {}),
          ...(packet.checkpoint.pendingClaim ? { pendingClaim: packet.checkpoint.pendingClaim } : {}),
          ...(packet.checkpoint.resume ? { resume: packet.checkpoint.resume } : {}),
        }
      : null
  } catch {
    throw new HandoffError(code)
  } finally {
    bytes?.fill(0)
    try {
      closeSync(4)
    } catch {}
    delete process.env.MONGOLGPT_RUNTIME_PREPARED_FD
  }
}
