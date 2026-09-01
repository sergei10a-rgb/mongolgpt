import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  extractSstAdminExternalState,
  formatSstAdminExternalStateEnv,
  readSstAdminExternalStateFile,
  SstAdminExternalStateError,
} from "../src/sst-admin-external-state"

const databaseId = "123E4567-E89B-42D3-A456-426614174000"
const d1BackupsBucket = "mongolgpt-dev-d1-backups"
const usageQueueReadinessNamespaceId = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
const serviceMonitorStateNamespaceId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
const authApiUrl = "https://auth.dev.mgpt.mn"
const quotaServiceUrl = "https://quota.dev.mgpt.mn"
const paymentServiceUrl = "https://pay.dev.mgpt.mn"
const quotaServiceToken = "quota-token-synth-01+alpha+beta+gamma+delta"
const paymentCancellationToken = "payment-cancel-token-synth-02+alpha+beta+gamma"
const paymentRefundToken = "payment-refund-token-synth-03+alpha+beta+gamma"

describe("SST admin external state resolver", () => {
  test("extracts the exact external admin references from checkpoint.latest.resources", () => {
    expect(
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            manifest: { stage: "dev" },
            resources: [
              resource("sst:cloudflare:D1", "Database", {
                databaseId,
                secret: "must-not-be-read",
                inputs: { databaseId: "wrong-value" },
              }),
              resource("sst:cloudflare:Bucket", "D1Backups", {
                name: d1BackupsBucket,
                inputs: { name: "wrong-value" },
              }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", {
                namespaceId: usageQueueReadinessNamespaceId,
                inputs: { namespaceId: "wrong-value" },
              }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", {
                namespaceId: serviceMonitorStateNamespaceId,
                inputs: { namespaceId: "wrong-value" },
              }),
              resource("sst:cloudflare:Worker", "AuthApi", {
                url: "https://auth.dev.mgpt.mn/",
                inputs: { url: "http://not-allowed.example" },
              }),
              resource("sst:cloudflare:Worker", "PaymentService", {
                url: "https://pay.dev.mgpt.mn/",
                inputs: { url: "http://not-allowed.example" },
              }),
              resource("sst:cloudflare:Worker", "QuotaService", {
                url: "https://quota.dev.mgpt.mn/",
                inputs: { url: "http://not-allowed.example" },
              }),
              resource("sst:cloudflare:Worker", "AuthApiShadow", {
                url: "https://shadow.dev.mgpt.mn/",
              }),
              {
                type: "sst:cloudflare:Worker",
                urn: "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker::QuotaServiceCopy",
                outputs: { url: "https://copy.dev.mgpt.mn/" },
              },
              passwordResource("QuotaServiceToken", {
                result: quotaServiceToken,
                inputs: { value: "not-a-token" },
              }),
              passwordResource("AdminPaymentCancellationToken", {
                result: paymentCancellationToken,
                inputs: { value: "not-a-token" },
              }),
              passwordResource("AdminPaymentRefundToken", {
                result: paymentRefundToken,
                inputs: { value: "not-a-token" },
              }),
            ],
          },
        },
      }),
    ).toEqual({
      databaseId: databaseId.toLowerCase(),
      d1BackupsBucket,
      usageQueueReadinessKvId: usageQueueReadinessNamespaceId,
      serviceMonitorStateKvId: serviceMonitorStateNamespaceId,
      authApiUrl,
      quotaServiceUrl,
      paymentServiceUrl,
      quotaServiceToken,
      paymentCancellationToken,
      paymentRefundToken,
    })
  })

  test("extracts provider child outputs when SST component outputs are empty", () => {
    const quotaWorkersDevUrl = "https://mongolgpt-dev-quota.workers.dev"
    expect(
      extractSstAdminExternalState({
        latest: {
          resources: [
            resource("sst:cloudflare:D1", "Database", {}),
            providerResource(
              "cloudflare:index/d1Database:D1Database",
              "DatabaseDatabase",
              { uuid: databaseId },
              `account/${databaseId}`,
            ),
            resource("sst:cloudflare:Bucket", "D1Backups", {}),
            providerResource(
              "cloudflare:index/r2Bucket:R2Bucket",
              "D1BackupsBucket",
              { name: d1BackupsBucket },
              `account/${d1BackupsBucket}`,
            ),
            resource("sst:cloudflare:Kv", "UsageQueueReadiness", {}),
            providerResource(
              "cloudflare:index/workersKvNamespace:WorkersKvNamespace",
              "UsageQueueReadinessNamespace",
              {},
              `account/${usageQueueReadinessNamespaceId}`,
            ),
            resource("sst:cloudflare:Kv", "ServiceMonitorState", {}),
            providerResource(
              "cloudflare:index/workersKvNamespace:WorkersKvNamespace",
              "ServiceMonitorStateNamespace",
              { id: serviceMonitorStateNamespaceId },
              `account/${serviceMonitorStateNamespaceId}`,
            ),
            resource("sst:cloudflare:Worker", "AuthApi", {}),
            providerResource("cloudflare:index/workersCustomDomain:WorkersCustomDomain", "AuthApiDomain", {
              hostname: "auth.dev.mgpt.mn",
            }),
            resource("sst:cloudflare:Worker", "QuotaService", {}),
            providerResource("pulumi-nodejs:dynamic:Resource", "QuotaServiceUrl.sst.cloudflare.WorkerUrl", {
              url: "mongolgpt-dev-quota.workers.dev",
            }),
            resource("sst:cloudflare:Worker", "PaymentService", {}),
            providerResource("cloudflare:index/workersCustomDomain:WorkersCustomDomain", "PaymentServiceDomain", {
              hostname: "pay.dev.mgpt.mn",
            }),
            passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
            passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
            passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
          ],
        },
      }),
    ).toEqual({
      databaseId: databaseId.toLowerCase(),
      d1BackupsBucket,
      usageQueueReadinessKvId: usageQueueReadinessNamespaceId,
      serviceMonitorStateKvId: serviceMonitorStateNamespaceId,
      authApiUrl,
      quotaServiceUrl: quotaWorkersDevUrl,
      paymentServiceUrl,
      quotaServiceToken,
      paymentCancellationToken,
      paymentRefundToken,
    })
  })

  test("formats only the approved key=value environment lines", () => {
    expect(
      formatSstAdminExternalStateEnv({
        databaseId: databaseId.toLowerCase(),
        d1BackupsBucket,
        usageQueueReadinessKvId: usageQueueReadinessNamespaceId,
        serviceMonitorStateKvId: serviceMonitorStateNamespaceId,
        authApiUrl,
        quotaServiceUrl,
        paymentServiceUrl,
        quotaServiceToken,
        paymentCancellationToken,
        paymentRefundToken,
      }),
    ).toEqual([
      `MONGOLGPT_ADMIN_DATABASE_ID=${databaseId.toLowerCase()}`,
      `MONGOLGPT_ADMIN_D1_BACKUPS_BUCKET=${d1BackupsBucket}`,
      `MONGOLGPT_ADMIN_USAGE_QUEUE_READINESS_KV_ID=${usageQueueReadinessNamespaceId}`,
      `MONGOLGPT_ADMIN_SERVICE_MONITOR_STATE_KV_ID=${serviceMonitorStateNamespaceId}`,
      `MONGOLGPT_ADMIN_AUTH_API_URL=${authApiUrl}`,
      `MONGOLGPT_ADMIN_QUOTA_SERVICE_URL=${quotaServiceUrl}`,
      `MONGOLGPT_ADMIN_PAYMENT_SERVICE_URL=${paymentServiceUrl}`,
      `MONGOLGPT_ADMIN_QUOTA_SERVICE_TOKEN=${quotaServiceToken}`,
      `MONGOLGPT_ADMIN_PAYMENT_CANCELLATION_TOKEN=${paymentCancellationToken}`,
      `MONGOLGPT_ADMIN_PAYMENT_REFUND_TOKEN=${paymentRefundToken}`,
    ])
  })

  test("rejects duplicate, missing, and malformed exact matches", () => {
    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("Database яг нэг")

    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("ServiceMonitorState")

    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId: "not-a-uuid" }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("UUID буруу")

    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: "badbucketname!" }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("bucket name буруу")

    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: "badnamespaceid!" }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("namespaceId буруу")

    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: "http://not-https.dev.mgpt.mn/" }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("HTTPS origin")

    expect(() =>
      extractSstAdminExternalState({
        checkpoint: {
          latest: {
            resources: [
              resource("sst:cloudflare:D1", "Database", { databaseId }),
              resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
              resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
              resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
              resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
              resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
              resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
              passwordResource("QuotaServiceToken", { result: "short-token" }),
              passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
              passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
            ],
          },
        },
      }),
    ).toThrow("secret output хэт богино")
  })

  test("CLI prints the vetted env lines from a CheckpointV3 state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mongolgpt-admin-state-"))
    const file = join(root, "state.json")
    try {
      await writeFile(
        file,
        JSON.stringify(
          {
            checkpoint: {
              latest: {
                resources: [
                  resource("sst:cloudflare:D1", "Database", { databaseId }),
                  resource("sst:cloudflare:Bucket", "D1Backups", { name: d1BackupsBucket }),
                  resource("sst:cloudflare:Kv", "UsageQueueReadiness", { namespaceId: usageQueueReadinessNamespaceId }),
                  resource("sst:cloudflare:Kv", "ServiceMonitorState", { namespaceId: serviceMonitorStateNamespaceId }),
                  resource("sst:cloudflare:Worker", "AuthApi", { url: authApiUrl }),
                  resource("sst:cloudflare:Worker", "QuotaService", { url: quotaServiceUrl }),
                  resource("sst:cloudflare:Worker", "PaymentService", { url: paymentServiceUrl }),
                  passwordResource("QuotaServiceToken", { result: quotaServiceToken }),
                  passwordResource("AdminPaymentCancellationToken", { result: paymentCancellationToken }),
                  passwordResource("AdminPaymentRefundToken", { result: paymentRefundToken }),
                ],
              },
            },
          },
          null,
          2,
        ),
      )
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../../script/resolve-sst-admin-external-state.ts"), file],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toBe(
        [
          `MONGOLGPT_ADMIN_DATABASE_ID=${databaseId.toLowerCase()}`,
          `MONGOLGPT_ADMIN_D1_BACKUPS_BUCKET=${d1BackupsBucket}`,
          `MONGOLGPT_ADMIN_USAGE_QUEUE_READINESS_KV_ID=${usageQueueReadinessNamespaceId}`,
          `MONGOLGPT_ADMIN_SERVICE_MONITOR_STATE_KV_ID=${serviceMonitorStateNamespaceId}`,
          `MONGOLGPT_ADMIN_AUTH_API_URL=${authApiUrl}`,
          `MONGOLGPT_ADMIN_QUOTA_SERVICE_URL=${quotaServiceUrl}`,
          `MONGOLGPT_ADMIN_PAYMENT_SERVICE_URL=${paymentServiceUrl}`,
          `MONGOLGPT_ADMIN_QUOTA_SERVICE_TOKEN=${quotaServiceToken}`,
          `MONGOLGPT_ADMIN_PAYMENT_CANCELLATION_TOKEN=${paymentCancellationToken}`,
          `MONGOLGPT_ADMIN_PAYMENT_REFUND_TOKEN=${paymentRefundToken}`,
        ].join("\n") + "\n",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("CLI fails closed on oversized state files before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mongolgpt-admin-state-oversized-"))
    const file = join(root, "state.json")
    try {
      await writeFile(file, " ".repeat(32 * 1024 * 1024 + 1))
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../../script/resolve-sst-admin-external-state.ts"), file],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toContain("32 MiB")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function resource(type: string, name: string, outputs: Record<string, unknown>) {
  return {
    type,
    urn: `urn:pulumi:dev::mongolgpt::${type}::${name}`,
    outputs,
  }
}

function passwordResource(name: string, outputs: Record<string, unknown>) {
  return resource("random:index/randomPassword:RandomPassword", name, outputs)
}

function providerResource(type: string, name: string, outputs: Record<string, unknown>, id?: string) {
  return {
    ...resource(type, name, outputs),
    ...(id ? { id } : {}),
  }
}
