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
        change("sst:sst:LinkRef", "AdminLinkRef", "create"),
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
        change("pulumi:providers:pulumi-nodejs", "default", "create"),
        change(
          "sst:cloudflare:SolidStart$sst:cloudflare:Worker$cloudflare:index/workerScript:WorkerScript",
          "AdminServerCode",
          "update",
          "cloudflare:index/workerScript:WorkerScript",
        ),
        change("pulumi:pulumi:Stack", "mongolgpt-admin-dev", "create"),
      ]),
    ).toEqual({ changes: 35, operations: { create: 33, update: 2 } })
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

  test("accepts only the admin bundle builder replacement lifecycle", () => {
    const builderType = "sst:cloudflare:SolidStart$command:local:Command"
    expect(
      inspectAdminDeploymentDiff([
        change(builderType, "AdminBuilder", "create-replacement"),
        change(builderType, "AdminBuilder", "replace"),
        change(builderType, "AdminBuilder", "delete-replaced"),
      ]),
    ).toEqual({
      changes: 3,
      operations: { "create-replacement": 1, replace: 1, "delete-replaced": 1 },
    })
    expect(() => inspectAdminDeploymentDiff([change(builderType, "AdminBuilder", "delete")])).toThrow("AdminBuilder")
    expect(() =>
      inspectAdminDeploymentDiff([change("command:local:Command", "AdminBuilder", "create-replacement")]),
    ).toThrow("AdminBuilder")
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
    expect(() => inspectAdminDeploymentDiff([change("pulumi:providers:pulumi-nodejs", "default", "update")])).toThrow(
      "default",
    )
  })

  test("an explicit dev cookie migration allows only the SameSite attribute update", () => {
    const entry = cookieMigration()
    expect(() => inspectAdminDeploymentDiff([entry])).toThrow("AdminAccessApplication")
    expect(inspectAdminDeploymentDiff([entry], { allowAccessCookieMigration: true })).toEqual({
      changes: 1,
      operations: { update: 1 },
    })
    for (const rejected of [
      { ...entry, urn: entry.urn.replace(":dev::", ":production::") },
      { ...entry, urn: entry.urn.replace("::mongolgpt-admin::", "::mongolgpt::") },
      { ...entry, type: "cloudflare:index/other:Other" },
      { ...entry, op: "replace" },
      { ...entry, op: "delete" },
      { ...entry, detailedDiff: {} },
      { ...entry, detailedDiff: { sameSiteCookieAttribute: { kind: "update" } } },
      { ...entry, detailedDiff: { sameSiteCookieAttribute: { diffKind: "delete" } } },
      { ...entry, detailedDiff: { sameSiteCookieAttribute: { diffKind: "update-replace" } } },
      { ...entry, detailedDiff: { ...entry.detailedDiff, "mfaConfig.mfaDisabled": { diffKind: "update" } } },
      { ...entry, detailedDiff: { ...entry.detailedDiff, policies: { diffKind: "update" } } },
      { ...entry, detailedDiff: { ...entry.detailedDiff, domain: { diffKind: "update" } } },
      { ...entry, detailedDiff: { ...entry.detailedDiff, enableBindingCookie: { diffKind: "update" } } },
    ]) {
      expect(() => inspectAdminDeploymentDiff([rejected], { allowAccessCookieMigration: true })).toThrow(
        AdminDeploymentDiffError,
      )
    }
  })

  test("accepts Pulumi output events without detailedDiff only with an exact input transition", () => {
    for (const detailedDiff of [null, undefined]) {
      for (const diffs of [null, undefined, ["sameSiteCookieAttribute"]]) {
        expect(
          inspectAdminDeploymentDiff([{ ...cookieMigration(), detailedDiff, diffs }], {
            allowAccessCookieMigration: true,
          }),
        ).toEqual({
          changes: 1,
          operations: { update: 1 },
        })
      }
    }
  })

  test("rejects cookie migrations with incomplete, opaque, or additional input and identity changes", () => {
    const entry = cookieMigration()
    for (const detailedDiff of [entry.detailedDiff, null]) {
      for (const rejected of [
        { ...entry, old: undefined },
        { ...entry, new: undefined },
        { ...entry, provider: "other-provider" },
        { ...entry, keys: ["sameSiteCookieAttribute"] },
        { ...entry, diffs: ["sameSiteCookieAttribute", "policies"] },
        { ...entry, diffs: [] },
        { ...entry, diffs: "sameSiteCookieAttribute" },
        { ...entry, old: { ...entry.old, inputs: undefined } },
        { ...entry, new: { ...entry.new, inputs: {} } },
        ...["urn", "type", "id", "provider", "parent", "protect"].map((key) => ({
          ...entry,
          new: { ...entry.new, [key]: "changed" },
        })),
        ...["none", "strict", "", null].map((sameSiteCookieAttribute) => ({
          ...entry,
          new: { ...entry.new, inputs: { ...entry.new.inputs, sameSiteCookieAttribute } },
        })),
        { ...entry, old: { ...entry.old, inputs: { ...entry.old.inputs, sameSiteCookieAttribute: "none" } } },
        ...[
          { enableBindingCookie: false },
          { httpOnlyCookieAttribute: false },
          { mfaConfig: { mfaDisabled: true } },
          { policies: [] },
          { domain: "other.example.test" },
          { added: true },
        ].map((inputs) => ({ ...entry, new: { ...entry.new, inputs: { ...entry.new.inputs, ...inputs } } })),
        ...[
          "[secret]",
          "04da6b54-80e4-46f7-96ec-b56ff0331ba9",
          {
            "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
            value: "opaque",
          },
        ].map((opaque) => ({
          ...entry,
          old: { ...entry.old, inputs: { ...entry.old.inputs, opaque } },
          new: { ...entry.new, inputs: { ...entry.new.inputs, opaque } },
        })),
      ]) {
        expect(() =>
          inspectAdminDeploymentDiff([{ ...rejected, detailedDiff }], { allowAccessCookieMigration: true }),
        ).toThrow(AdminDeploymentDiffError)
      }
    }
  })

  test("does not lose removed or prototype-named input fields when comparing the migration", () => {
    const entry = cookieMigration()
    const missing = { ...entry.new.inputs } as Record<string, unknown>
    delete missing.enableBindingCookie
    for (const inputs of [missing, { ...entry.new.inputs, ["__proto__"]: { hiddenChange: true } }]) {
      expect(() =>
        inspectAdminDeploymentDiff([{ ...entry, detailedDiff: null, new: { ...entry.new, inputs } }], {
          allowAccessCookieMigration: true,
        }),
      ).toThrow("other-input-changes")
    }
  })

  test("rejects an unexpectedly large plan", () => {
    expect(() =>
      inspectAdminDeploymentDiff(
        Array.from({ length: 2_001 }, () => change("sst:cloudflare:SolidStart", "Admin", "create")),
      ),
    ).toThrow("хэт олон")
  })

  test("cookie migration diagnostics never print values or arbitrary property paths", () => {
    const entry = {
      ...change(
        "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication",
        "AdminAccessApplication",
        "update",
      ),
      detailedDiff: {
        sameSiteCookieAttribute: { diffKind: "update" },
        "policies[private@example.com]": { diffKind: "secret-value", new: "do-not-print" },
      },
    }
    try {
      inspectAdminDeploymentDiff([entry], { allowAccessCookieMigration: true })
      throw new Error("Expected the migration to be rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(AdminDeploymentDiffError)
      expect(String(error)).toContain("sameSiteCookieAttribute:update")
      expect(String(error)).not.toContain("private@example.com")
      expect(String(error)).not.toContain("do-not-print")
      expect(String(error)).not.toContain("secret-value")
    }
  })
})

function cookieMigration() {
  const entry = change(
    "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication",
    "AdminAccessApplication",
    "update",
  )
  const state = {
    urn: entry.urn,
    type: entry.type,
    id: "test-access-app",
    provider: "test-cloudflare-provider",
    parent: `${stack}::pulumi:pulumi:Stack::mongolgpt-admin-dev`,
    custom: true,
    protect: true,
    inputs: {
      sameSiteCookieAttribute: "strict",
      domain: "admin.dev.example.test",
      enableBindingCookie: true,
      httpOnlyCookieAttribute: true,
      mfaConfig: { mfaDisabled: false },
      policies: [{ id: "test-admin-policy" }],
    },
  }
  return {
    ...entry,
    provider: state.provider,
    keys: [],
    diffs: ["sameSiteCookieAttribute"],
    detailedDiff: { sameSiteCookieAttribute: { diffKind: "update", inputDiff: true } },
    old: state,
    new: { ...state, inputs: { ...state.inputs, sameSiteCookieAttribute: "lax" } },
  }
}

function change(urnType: string, name: string, op: string, type = urnType.split("$").at(-1)!) {
  return {
    urn: `${stack}::${urnType}::${name}`,
    type,
    op,
  }
}
