import { collectSystemReadiness } from "../../../console/admin/src/lib/system-readiness"
import { usageQueueReadinessKey } from "../../../console/core/src/usage-queue-readiness"
import scheduled from "../../../console/function/src/usage-queue-heartbeat"
import usageQueue from "../../../console/function/src/usage-queue"

type Environment = {
  UsageQueue: Queue
  UsageQueueReadiness: KVNamespace
  UsageQueueReceipts: KVNamespace
}

const stage = "dev"
const devKey = usageQueueReadinessKey(stage)
const productionKey = usageQueueReadinessKey("production")
const legacyKey = "usage-queue:last-processed"
const receiptPrefix = "receipt:"

export default {
  async queue(batch, env) {
    await usageQueue.queue(batch)
    await Promise.all(
      batch.messages.map(async (message) => {
        const id = fixtureMessageID(message.body)
        if (id) await env.UsageQueueReceipts.put(`${receiptPrefix}${id}`, JSON.stringify({ processed: true }))
      }),
    )
  },
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== "POST" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
      return new Response(null, { status: 404 })
    }
    try {
      if (url.pathname === "/scheduled") {
        await scheduled.scheduled()
        return Response.json({ ok: true })
      }
      if (url.pathname === "/legacy") {
        await env.UsageQueue.send({
          type: "usage-queue-heartbeat",
          version: 1,
          id: "legacy-local-workerd-heartbeat",
          sentAt: Date.now(),
        })
        return Response.json({ ok: true })
      }
      if (url.pathname === "/wrong-stage") {
        await env.UsageQueue.send({
          type: "usage-queue-heartbeat",
          version: 2,
          stage: "production",
          id: "wrong-stage-local-workerd-heartbeat",
          sentAt: Date.now(),
        })
        return Response.json({ ok: true })
      }
      if (url.pathname === "/state") {
        const [dev, production, legacy, legacyReceipt, wrongStageReceipt] = await Promise.all([
          env.UsageQueueReadiness.get(devKey),
          env.UsageQueueReadiness.get(productionKey),
          env.UsageQueueReadiness.get(legacyKey),
          env.UsageQueueReceipts.get(`${receiptPrefix}legacy-local-workerd-heartbeat`),
          env.UsageQueueReceipts.get(`${receiptPrefix}wrong-stage-local-workerd-heartbeat`),
        ])
        const report = await collectSystemReadiness({
          stage,
          databaseID: "00000000-0000-4000-8000-000000000001",
          runtimeURL: "",
          releaseVersion: "",
          backupsEnabled: false,
          monitoringEnabled: false,
          database: async () => {
            throw new Error("fixture database probe intentionally unavailable")
          },
          auth: async () => Response.json({ status: "unavailable" }, { status: 503 }),
          quota: async () => Response.json({ status: "unavailable" }, { status: 503 }),
          payments: async () => Response.json({ status: "unavailable" }, { status: 503 }),
          runtime: async () => Response.json({ status: "unavailable" }, { status: 503 }),
          queueHeartbeat: () => env.UsageQueueReadiness.get(devKey),
          monitorEvidence: async () => {
            throw new Error("fixture monitoring probe intentionally unavailable")
          },
          backups: async () => {
            throw new Error("fixture backup probe intentionally unavailable")
          },
          release: async () => {
            throw new Error("fixture release probe intentionally unavailable")
          },
          now: () => new Date(),
        })
        return Response.json({
          keys: {
            dev,
            production,
            legacy,
          },
          receipts: {
            legacy: legacyReceipt,
            wrongStage: wrongStageReceipt,
          },
          readiness: report.checks.find((check) => check.id === "usage-queue"),
          status: report.status,
        })
      }
      return new Response(null, { status: 404 })
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "fixture_operation_failed" },
        { status: 409 },
      )
    }
  },
} satisfies ExportedHandler<Environment>

function fixtureMessageID(body: unknown) {
  if (!body || typeof body !== "object" || !("id" in body)) return undefined
  const id = (body as { id: unknown }).id
  return typeof id === "string" &&
    (id === "legacy-local-workerd-heartbeat" || id === "wrong-stage-local-workerd-heartbeat")
    ? id
    : undefined
}
