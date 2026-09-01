import { describe, expect, test } from "bun:test"
import { AdminDeploymentDiffError, inspectAdminDeploymentDiff } from "../src/sst-admin-diff"

const stack = "urn:pulumi:dev::mongolgpt-admin"

describe("admin-only SST diff boundary", () => {
  test("accepts only the admin site, Access resources, bootstrap secret, and bounded stack outputs", () => {
    expect(
      inspectAdminDeploymentDiff([
        change("sst:sst:Secret", "MongolGPTAdminBootstrapEmails", "create"),
        change("pulumi:providers:cloudflare", "AdminAccessProvider", "create"),
        change("pulumi:providers:command", "default_1_0_1", "create"),
        change("command:local:Command", "AdminAccessOrganizationMfa", "update"),
        change(
          "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication",
          "AdminAccessApplication",
          "create",
        ),
        change("sst:sst:Linkable", "AdminAccessConfig", "create"),
        change("sst:sst:Linkable", "Database", "create"),
        change("sst:sst:Linkable", "D1Backups", "create"),
        change("sst:sst:Linkable", "UsageQueueReadiness", "create"),
        change("sst:sst:Linkable", "ServiceMonitorState", "create"),
        change("sst:sst:Linkable", "AuthApi", "create"),
        change("sst:sst:Linkable", "QuotaService", "create"),
        change("sst:sst:Linkable", "PaymentService", "create"),
        change("sst:sst:Linkable", "QuotaServiceToken", "create"),
        change("sst:sst:Linkable", "AdminPaymentCancellationToken", "create"),
        change("sst:sst:Linkable", "AdminPaymentRefundToken", "create"),
        change("sst:sst:Secret", "MONGOLGPT_PLAN_LIMITS", "create"),
        change("pulumi:providers:cloudflare", "default_6_15_0", "create"),
        change("sst:sst:LinkRef", "AdminAccessConfigLinkRef", "create"),
        change("sst:sst:LinkRef", "AdminPaymentCancellationTokenLinkRef", "create"),
        change("sst:sst:LinkRef", "AdminPaymentRefundTokenLinkRef", "create"),
        change("sst:sst:LinkRef", "AuthApiLinkRef", "create"),
        change("sst:sst:LinkRef", "D1BackupsLinkRef", "create"),
        change("sst:sst:LinkRef", "DatabaseLinkRef", "create"),
        change("sst:sst:LinkRef", "MONGOLGPT_PLAN_LIMITSLinkRef", "create"),
        change("sst:sst:LinkRef", "MongolGPTAdminBootstrapEmailsLinkRef", "create"),
        change("sst:sst:LinkRef", "PaymentServiceLinkRef", "create"),
        change("sst:sst:LinkRef", "QuotaServiceLinkRef", "create"),
        change("sst:sst:LinkRef", "QuotaServiceTokenLinkRef", "create"),
        change("sst:sst:LinkRef", "ServiceMonitorStateLinkRef", "create"),
        change("sst:sst:LinkRef", "UsageQueueReadinessLinkRef", "create"),
        change(
          "sst:cloudflare:SolidStart$sst:cloudflare:Worker$cloudflare:index/workerScript:WorkerScript",
          "AdminServerCode",
          "update",
          "cloudflare:index/workerScript:WorkerScript",
        ),
        change("pulumi:pulumi:Stack", "mongolgpt-admin-dev", "create"),
      ]),
    ).toEqual({ changes: 33, operations: { create: 31, update: 2 } })
  })

  test("accepts only bounded outputs on the existing isolated admin stack", () => {
    expect(
      inspectAdminDeploymentDiff([
        {
          ...change("pulumi:pulumi:Stack", "mongolgpt-admin-dev", "update"),
          detailedDiff: {
            "outputs.AdminUrl": { kind: "update" },
            "outputs.HostedServices": { kind: "update" },
          },
        },
      ]),
    ).toEqual({ changes: 1, operations: { update: 1 } })
    expect(() => inspectAdminDeploymentDiff([change("pulumi:pulumi:Stack", "mongolgpt-dev", "create")])).toThrow(
      "mongolgpt-dev",
    )
  })

  test.each([
    ["sst:cloudflare:D1", "Database"],
    ["sst:cloudflare:Worker", "AuthApi"],
    ["sst:cloudflare:Worker", "PaymentService"],
    ["sst:cloudflare:Kv", "UsageQueueReadiness"],
    ["sst:sst:Secret", "AdminPaymentRefundToken"],
    ["pulumi:providers:cloudflare", "default_6_14_0"],
  ])("rejects shared dependency changes: %s %s", (type, name) => {
    expect(() => inspectAdminDeploymentDiff([change(type, name, "update")])).toThrow(AdminDeploymentDiffError)
  })

  test("rejects unrelated stack output changes and malformed JSON", () => {
    expect(() =>
      inspectAdminDeploymentDiff([
        {
          ...change("pulumi:pulumi:Stack", "mongolgpt-dev", "update"),
          detailedDiff: { "outputs.Database": { kind: "update" } },
        },
      ]),
    ).toThrow("зөвшөөрөөгүй")
    expect(() => inspectAdminDeploymentDiff({})).toThrow("JSON жагсаалт")
    expect(() => inspectAdminDeploymentDiff([{ op: "create" }])).toThrow("urn, type эсвэл op")
  })

  test("rejects destructive admin operations and reports multiple shared changes without values", () => {
    expect(() =>
      inspectAdminDeploymentDiff([
        change("sst:cloudflare:SolidStart", "Admin", "delete"),
        change("sst:cloudflare:Worker", "AuthApi", "update"),
        change("sst:cloudflare:D1", "Database", "update"),
      ]),
    ).toThrow(
      "delete sst:cloudflare:SolidStart Admin; update sst:cloudflare:Worker AuthApi; update sst:cloudflare:D1 Database",
    )
  })

  test("does not mutate the Access boundary through a routine admin deploy", () => {
    expect(() =>
      inspectAdminDeploymentDiff([
        change(
          "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication",
          "AdminAccessApplication",
          "update",
        ),
      ]),
    ).toThrow("AdminAccessApplication")
    expect(() => inspectAdminDeploymentDiff([change("sst:sst:Linkable", "AdminAccessConfig", "update")])).toThrow(
      "AdminAccessConfig",
    )
    expect(() => inspectAdminDeploymentDiff([change("sst:sst:LinkRef", "AuthApiLinkRef", "update")])).toThrow(
      "AuthApiLinkRef",
    )
    expect(() => inspectAdminDeploymentDiff([change("sst:sst:LinkRef", "UnknownLinkRef", "create")])).toThrow(
      "UnknownLinkRef",
    )
  })

  test("rejects an unexpectedly large plan", () => {
    expect(() =>
      inspectAdminDeploymentDiff(
        Array.from({ length: 2_001 }, () => change("sst:cloudflare:SolidStart", "Admin", "create")),
      ),
    ).toThrow("хэт олон")
  })
})

function change(urnType: string, name: string, op: string, type = urnType.split("$").at(-1)!) {
  return {
    urn: `${stack}::${urnType}::${name}`,
    type,
    op,
  }
}
