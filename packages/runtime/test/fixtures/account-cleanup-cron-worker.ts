import retention from "../../../console/function/src/account-deletion"
import { requestAccountDeletion } from "../../../console/core/src/account-deletion"
import { createHistoryStore } from "../../src/history"
import { createRetirableBackupBucket } from "../../src/backup-writes"
import { registerRuntimeSandbox } from "../../src/account-cleanup"
import { deriveRuntimeIdentity } from "../../src/runtime"
import { RetirementSandbox } from "./sandbox-retirement-worker"
import type { RuntimeAccountCleanup } from "../../src/account-cleanup-service"

export { ContainerProxy, RuntimeAccountCleanup } from "../../src/index"
export { RetirementSandbox }

type Environment = Omit<ConstructorParameters<typeof RetirementSandbox>[1], "Cleanup"> & {
  Database: D1Database
  RuntimeAccountCleanup: Service<RuntimeAccountCleanup>
}

const accountID = "acc_cron_cleanup"
const workspaceID = "wrk_cron_cleanup"
const neighborID = "acc_cron_neighbor"

// Local-only plumbing. The actual scheduled handler uses its production
// Resource adapter, D1 driver and named service RPC without stubs.
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== "POST" || !["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response(null, { status: 404 })
    try {
      if (url.pathname === "/migrate-console" || url.pathname === "/migrate-runtime") {
        const db = url.pathname === "/migrate-console" ? env.Database : env.HISTORY
        for (const query of await request.json<string[]>()) await db.prepare(query).run()
        return Response.json({ ok: true })
      }
      if (url.pathname === "/seed-console") {
        for (const [id, user, workspace] of [
          [accountID, "usr_cron_cleanup", workspaceID],
          [neighborID, "usr_cron_neighbor", "wrk_cron_neighbor"],
        ]) {
          await env.Database.batch([
            env.Database.prepare("INSERT INTO account (id) VALUES (?)").bind(id),
            env.Database.prepare("INSERT INTO workspace (id, name) VALUES (?, 'Private fixture project')").bind(
              workspace,
            ),
            env.Database.prepare(
              "INSERT INTO user (id, workspace_id, account_id, name, role) VALUES (?, ?, ?, 'Private fixture name', 'admin')",
            ).bind(user, workspace, id),
            env.Database.prepare("INSERT INTO auth (id, provider, subject, account_id) VALUES (?, 'email', ?, ?)").bind(
              `aut_${id}`,
              `${id}@example.invalid`,
              id,
            ),
            env.Database.prepare(
              "INSERT INTO key (id, workspace_id, user_id, name, key) VALUES (?, ?, ?, 'Fixture key', ?)",
            ).bind(`key_${id}`, workspace, user, `fixture_${id}`),
            env.Database.prepare(
              "INSERT INTO provider (id, workspace_id, provider, credentials) VALUES (?, ?, 'fixture', 'private fixture credentials')",
            ).bind(`prv_${id}`, workspace),
          ])
        }
        return Response.json(await requestAccountDeletion({ accountID, graceMs: 0 }))
      }
      if (url.pathname === "/seed-runtime") {
        for (const id of [accountID, neighborID]) {
          const scope = { accountID: id, workspaceID }
          const identities = await identitiesFor(env, id)
          for (const identity of identities) {
            await registerRuntimeSandbox(env.HISTORY, scope, identity.toString())
            await env.Sandbox.get(identity).prepare()
          }
          await createHistoryStore(env.HISTORY).claim(scope, { expectedEpoch: 0, writerID: "writer_cron" })
          await env.HISTORY.batch([
            env.HISTORY.prepare(
              "INSERT INTO runtime_history_session (account_id, workspace_id, session_id) VALUES (?, ?, 'ses_cron')",
            ).bind(id, workspaceID),
            env.HISTORY.prepare(
              "INSERT INTO runtime_history_event (account_id,workspace_id,session_id,event_id,seq,type,data,digest) VALUES (?,?,'ses_cron','evt_cron',0,'message','private fixture history','digest')",
            ).bind(id, workspaceID),
          ])
          await createRetirableBackupBucket(env.HISTORY, env.RUNTIME_BACKUPS, scope).put(
            `runtime-backups/v1/${id}/${workspaceID}/00000000-0000-4000-8000-000000000001/000000.bin`,
            "private synthetic backup",
            { onlyIf: { etagDoesNotMatch: "*" } },
          )
        }
        await env.HISTORY.prepare(
          "CREATE TRIGGER fixture_runtime_failure BEFORE DELETE ON runtime_history_event WHEN OLD.account_id = 'acc_cron_cleanup' BEGIN SELECT RAISE(ABORT, 'synthetic runtime failure'); END",
        ).run()
        return Response.json({ ok: true })
      }
      if (url.pathname === "/console-failure") {
        await env.HISTORY.prepare("DROP TRIGGER fixture_runtime_failure").run()
        await env.Database.prepare(
          "CREATE TRIGGER fixture_console_failure BEFORE UPDATE ON provider WHEN OLD.id = 'prv_acc_cron_cleanup' BEGIN SELECT RAISE(ABORT, 'synthetic console failure'); END",
        ).run()
        await retryNow(env)
        return Response.json({ ok: true })
      }
      if (url.pathname === "/allow-completion") {
        await env.Database.prepare("DROP TRIGGER fixture_console_failure").run()
        await retryNow(env)
        return Response.json({ ok: true })
      }
      if (["/cron", "/cron-before-eligible", "/purge"].includes(url.pathname)) {
        const eligibleAt = await env.Database.prepare("SELECT time_eligible FROM account_deletion WHERE account_id = ?")
          .bind(accountID)
          .first<number>("time_eligible")
        if (!Number.isSafeInteger(eligibleAt) || eligibleAt === null || eligibleAt < 1)
          throw new Error("Fixture deletion eligibility is missing")
        // Exercise both sides of the eligibility boundary with the real
        // scheduled handler, independent of host clock adjustments between requests.
        const scheduledTime =
          url.pathname === "/purge"
            ? Date.now() + 31 * 24 * 60 * 60_000
            : eligibleAt - (url.pathname === "/cron-before-eligible" ? 1 : 0)
        await retention.scheduled({ scheduledTime })
        return Response.json({ ok: true, scheduledTime })
      }
      if (url.pathname === "/eligibility")
        return Response.json(
          await env.Database.prepare(
            "SELECT time_eligible, attempts, last_error_code FROM account_deletion WHERE account_id = ?",
          )
            .bind(accountID)
            .first(),
        )
      if (url.pathname === "/state" || url.pathname === "/neighbor") {
        const id = url.pathname === "/state" ? accountID : neighborID
        const identities = await identitiesFor(env, id)
        return Response.json({
          account: await env.Database.prepare("SELECT time_deleted, auth_version FROM account WHERE id = ?")
            .bind(id)
            .first(),
          request: await env.Database.prepare("SELECT id, status FROM account_deletion WHERE account_id = ?")
            .bind(id)
            .first(),
          cleanup: await env.Database.prepare(
            "SELECT workspace_ids, time_runtime_completed, time_completed, last_error_code, attempts FROM account_deletion_cleanup WHERE account_id = ?",
          )
            .bind(id)
            .first(),
          user: await env.Database.prepare("SELECT name, account_id FROM user WHERE id = ?")
            .bind(id === accountID ? "usr_cron_cleanup" : "usr_cron_neighbor")
            .first(),
          auth: await env.Database.prepare("SELECT count(*) AS n FROM auth WHERE account_id = ?")
            .bind(id)
            .first<number>("n"),
          key: await env.Database.prepare("SELECT key, time_deleted FROM key WHERE id = ?").bind(`key_${id}`).first(),
          provider: await env.Database.prepare("SELECT credentials FROM provider WHERE id = ?")
            .bind(`prv_${id}`)
            .first(),
          runtime: await env.HISTORY.prepare("SELECT phase FROM runtime_account_cleanup WHERE account_id = ?")
            .bind(id)
            .first(),
          content: await env.HISTORY.prepare("SELECT data FROM runtime_history_event WHERE account_id = ?")
            .bind(id)
            .first(),
          backups: (await env.RUNTIME_BACKUPS.list({ prefix: `runtime-backups/v1/${id}/` })).objects.length,
          sandboxes: await Promise.all(identities.map((identity) => env.Sandbox.get(identity).status())),
        })
      }
      if (url.pathname === "/preflight-state")
        return Response.json({
          account: await env.Database.prepare("SELECT time_deleted, auth_version FROM account WHERE id = ?")
            .bind(accountID)
            .first(),
          request: await env.Database.prepare("SELECT status FROM account_deletion WHERE account_id = ?")
            .bind(accountID)
            .first(),
        })
      return new Response(null, { status: 404 })
    } catch {
      return Response.json({ error: "fixture_operation_failed" }, { status: 409 })
    }
  },
} satisfies ExportedHandler<Environment>

async function retryNow(env: Environment) {
  await env.Database.prepare("UPDATE account_deletion_cleanup SET time_next_attempt = 0 WHERE account_id = ?")
    .bind(accountID)
    .run()
}

async function identitiesFor(env: Environment, id: string) {
  const secrets =
    id === accountID
      ? [env.MONGOLGPT_RUNTIME_SECRET, "synthetic-previous-cron-secret-at-least-thirty-two-characters"]
      : [env.MONGOLGPT_RUNTIME_SECRET]
  const result = []
  for (const secret of secrets) {
    const identity = await deriveRuntimeIdentity(id, workspaceID, secret)
    result.push(env.Sandbox.idFromName(identity.sandboxID))
  }
  return result
}
