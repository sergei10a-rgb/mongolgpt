import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import {
  AdminAccessStateError,
  devAdminAccess,
  reconcileAdminAccessState,
} from "../packages/script/src/admin-access-state"
import { verifyCloudflareAdminAccess } from "@mongolgpt/script/cloudflare-access"

try {
  const [mode, path, ...extra] = process.argv.slice(2)
  const editor = mode === "--edit" || mode === "--snapshot"
  if (extra.length || !["--audit", "--verify", "--edit", "--snapshot"].includes(mode ?? "") || (!editor && path)) {
    throw new AdminAccessStateError("Expected an audit, verification, snapshot, or edit operation")
  }
  if (process.env.MONGOLGPT_DOMAIN !== "mgpt.mn" || process.env.CLOUDFLARE_ACCOUNT_ID !== devAdminAccess.accountId) {
    throw new AdminAccessStateError("Only the existing mgpt.mn dev account is supported")
  }
  if (editor && process.env.MONGOLGPT_RECONCILE_ADMIN_ACCESS_STATE !== "CONFIRM DEV ADMIN COOKIE STATE") {
    throw new AdminAccessStateError("Explicit dev state reconciliation confirmation is required")
  }

  // The editor runs under SST's state lock; no provider refresh or cloud configuration write is performed.
  const file = editor ? await checkpointPath(path) : undefined
  const text = file ? await readFile(file, "utf8") : await Bun.stdin.text()
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new AdminAccessStateError("Checkpoint is too large")
  const parsed: unknown = JSON.parse(text)
  if (editor && (parsed === null || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 3)) {
    throw new AdminAccessStateError("SST editor requires a wrapped version-3 checkpoint")
  }
  const result = reconcileAdminAccessState(parsed)
  await verifyCloudflareAdminAccess({
    accountId: devAdminAccess.accountId,
    applicationId: devAdminAccess.applicationId,
    hostname: devAdminAccess.hostname,
    stage: "dev",
    token: process.env.CLOUDFLARE_ACCESS_API_TOKEN ?? "",
    bootstrapEmails: process.env.SST_SECRET_MongolGPTAdminBootstrapEmails ?? "",
  })
  if (mode === "--verify" && result.changed) throw new AdminAccessStateError("State is not yet reconciled")
  if (file && !result.changed) {
    // A nonzero editor exit prevents SST from pushing a needless checkpoint.
    throw new AdminAccessStateError("Already reconciled; no state write is needed")
  }
  if (file) {
    const temp = process.env.RUNNER_TEMP
    if (!temp) throw new AdminAccessStateError("Private runner backup directory is required")
    const backup = join(await realpath(temp), "mongolgpt-admin-cookie-state-before.json")
    if (mode === "--snapshot") {
      // SST state edit pushes an exact baseline snapshot before the separate repair is permitted.
      await writeFile(backup, text, { flag: "wx", mode: 0o600 })
    }
    if (mode === "--edit") {
      if ((await readFile(backup, "utf8")) !== text)
        throw new AdminAccessStateError("State changed since the baseline snapshot")
      const output = `${JSON.stringify(result.state, null, 2)}\n`
      if (reconcileAdminAccessState(JSON.parse(output)).changed)
        throw new AdminAccessStateError("State verification failed")
      const pending = join(dirname(file), "dev.cookie-reconcile.tmp")
      await writeFile(pending, output, { flag: "wx", mode: 0o600 })
      await rename(pending, file)
    }
  }
  console.log(
    mode === "--audit"
      ? JSON.stringify({ changed: result.changed, liveProtectionVerified: true })
      : file
        ? "Dev admin cookie state editor completed; live protection verified."
        : "Live protection verified; dev admin cookie state is already reconciled.",
  )
} catch {
  // Never print state, provider responses, secrets, filesystem errors, or JSON parsing excerpts.
  console.error(
    "Dev admin state reconciliation stopped. No broader changes are allowed; inspect configuration privately.",
  )
  process.exitCode = 1
}

async function checkpointPath(path: string | undefined) {
  if (!path) throw new AdminAccessStateError("Checkpoint path is required")
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
    throw new AdminAccessStateError("Invalid checkpoint file")
  const file = await realpath(path)
  const base = await realpath(resolve(".sst/pulumi"))
  const local = relative(base, file).replaceAll("\\", "/")
  if (!/^[A-Za-z0-9_-]+\/\.pulumi\/stacks\/mongolgpt-admin\/dev\.json$/.test(local)) {
    throw new AdminAccessStateError("Checkpoint must belong to the isolated dev admin SST workdir")
  }
  return file
}
