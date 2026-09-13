import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ConsoleUiDeploymentGuardError, verifyConsoleUiDeploymentDiff } from "../src/console-ui-deployment-guard"

const prefix = "urn:pulumi:dev::mongolgpt::"
const siteType = "sst:cloudflare:SolidStart"
const workerType = "sst:cloudflare:Worker"
const scriptType = "cloudflare:index/workersScript:WorkersScript"
const site = `${prefix}${siteType}::Console`
const worker = `${prefix}${siteType}$${workerType}::ConsoleWorker`
const accountId = "cc97ad90bfaf8a1da5de612eef2658f5"
const scriptName = "mongolgpt-dev-consoleworkerscript"
const unknown = "04da6b54-80e4-46f7-96ec-b56ff0331ba9"

function event(type: string, name: string, parent: string, inputs: Record<string, unknown>, nested = true) {
  const urn = `${prefix}${nested ? parent.split("::")[2] + "$" : ""}${type}::${name}`
  const state = { urn, type, parent, id: "existing-id", custom: true, provider: "provider-ref", inputs, outputs: {} }
  return { urn, type, op: "update", provider: "provider-ref", old: structuredClone(state), new: structuredClone(state) }
}

function script() {
  const entry = event(scriptType, "ConsoleWorkerScript", worker, {
    accountId,
    scriptName,
    mainModule: "placeholder",
    contentFile: "/repo/.sst/artifacts/ConsoleWorker/index.mjs",
    contentSha256: "a".repeat(64),
    compatibilityDate: "2026-07-15",
    compatibilityFlags: ["nodejs_compat"],
    bindings: [
      { name: "ASSETS", type: "assets" },
      { name: "Database", type: "d1", id: "synthetic-db" },
      { name: "QuotaService", type: "service", service: "mongolgpt-dev-quotaservicescript" },
      { name: "MONGOLGPT_GATEWAY_MODELS1", type: "plain_text", text: "synthetic-model-config" },
    ],
    assets: { directory: "/repo/packages/console/app/.output/public", config: {} },
  })
  entry.new.inputs.contentSha256 = "b".repeat(64)
  return entry
}

function builder() {
  const entry = event("command:local:Command", "ConsoleBuilder", site, {
    create: "bun run build",
    update: "bun run build",
    dir: "/repo/packages/console/app",
    environment: { SST: "1", VITE_MONGOLGPT_PREVIEW_ENABLED: "true" },
    triggers: ["1780000000000"],
  })
  entry.new.inputs.triggers = ["1780000000001"]
  return entry
}

function url() {
  const entry = event("pulumi-nodejs:dynamic:Resource", "ConsoleWorkerUrl.sst.cloudflare.WorkerUrl", worker, {
    accountId,
    scriptName,
    enabled: true,
    etag: "synthetic-old-etag",
    __provider: "synthetic-provider-code",
  })
  entry.new.inputs.etag = unknown
  return entry
}

function rejects(value: unknown) {
  expect(() => verifyConsoleUiDeploymentDiff(value)).toThrow(ConsoleUiDeploymentGuardError)
}

describe("Console UI deployment guard", () => {
  test("accepts representative SST WorkersScript inputs and exact local build replacement", () => {
    expect(verifyConsoleUiDeploymentDiff([script(), builder(), url()])).toEqual({
      workerUpdates: 1,
      builderUpdates: 1,
      urlUpdates: 1,
    })
    const local = builder()
    local.op = "replace"
    local.new.id = ""
    expect(
      verifyConsoleUiDeploymentDiff([
        script(),
        {
          ...local,
          keys: ["triggers"],
          diffs: ["triggers"],
          detailedDiff: { "triggers[0]": { diffKind: "update-replace", inputDiff: true } },
        },
      ]).builderUpdates,
    ).toBe(1)
  })

  test("accepts asset manifest changes but not routing configuration", () => {
    const entry = script()
    entry.old.inputs.assets = {
      directory: "/repo/packages/console/app/.output/public",
      config: {},
      assetManifestSha256: "a".repeat(64),
    }
    entry.new.inputs.assets = {
      directory: "/repo/packages/console/app/.output/public",
      config: {},
      assetManifestSha256: "b".repeat(64),
    }
    expect(verifyConsoleUiDeploymentDiff([entry]).workerUpdates).toBe(1)
    entry.new.inputs.assets = {
      ...(entry.new.inputs.assets as object),
      config: { redirects: "/ https://other.invalid" },
    }
    rejects([entry])
  })

  test.each([
    "bindings",
    "compatibilityDate",
    "compatibilityFlags",
    "mainModule",
    "migrations",
    "accountId",
    "scriptName",
    "placement",
    "keepBindings",
    "keepAssets",
    "observability",
    "content",
    "usageModel",
  ])("rejects changed %s", (key) => {
    const entry = script()
    entry.new.inputs[key] = "private-do-not-print"
    rejects([entry])
  })

  test("rejects gateway model, DB, auth, service and secret binding changes hidden by code-only metadata", () => {
    for (const name of [
      "MONGOLGPT_GATEWAY_MODELS1",
      "Database",
      "AUTH_API_URL",
      "MFA",
      "QuotaService",
      "SESSION_SECRET",
    ]) {
      const entry = script()
      entry.new.inputs.bindings = [{ name, type: "plain_text", text: "private-do-not-print" }]
      rejects([
        {
          ...entry,
          diffs: ["contentSha256"],
          detailedDiff: { contentSha256: { diffKind: "update", inputDiff: true } },
        },
      ])
    }
  })

  test.each([
    "[secret]",
    "[unknown]",
    unknown,
    { secure: "same-ciphertext" },
    { __pulumiUnknown: true },
    { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", ciphertext: "[secret]" },
  ])("rejects equal opaque protected bindings", (hidden) => {
    const entry = script()
    entry.old.inputs.bindings = [{ name: "SESSION_SECRET", type: "secret_text", text: hidden }]
    entry.new.inputs.bindings = structuredClone(entry.old.inputs.bindings)
    rejects([entry])
  })

  test("rejects changed or opaque local build environment and executable", () => {
    for (const key of ["create", "update", "environment", "dir"]) {
      const entry = builder()
      entry.new.inputs[key] = "private-do-not-print"
      rejects([script(), entry])
    }
    const entry = builder()
    entry.old.inputs.environment = entry.new.inputs.environment = { TOKEN: "[secret]" }
    rejects([script(), entry])
  })

  test("permits exact SecretV1 masks only with independent provider code-only proof", () => {
    const mask = { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", ciphertext: "[secret]" }
    const entry = script()
    entry.old.inputs.bindings = entry.new.inputs.bindings = [
      { name: "SESSION_SECRET", type: "secret_text", text: mask },
    ]
    const proof = {
      ...entry,
      diffs: ["contentSha256"],
      detailedDiff: { contentSha256: { diffKind: "update", inputDiff: false } },
    }
    expect(verifyConsoleUiDeploymentDiff([proof]).workerUpdates).toBe(1)
    rejects([{ ...proof, diffs: [] }])
    rejects([{ ...proof, diffs: ["contentSha256", "bindings"] }])
    rejects([{ ...proof, detailedDiff: { "bindings[0].text": { diffKind: "update", inputDiff: false } } }])
    rejects([{ ...proof, detailedDiff: { contentSha256: { diffKind: "update-replace", inputDiff: false } } }])
    const changed = structuredClone(proof)
    changed.new.inputs.bindings = [{ name: "OTHER_SECRET", type: "secret_text", text: mask }]
    rejects([changed])
    entry.old.inputs.bindings = entry.new.inputs.bindings = mask
    expect(verifyConsoleUiDeploymentDiff([{ ...entry, diffs: ["contentSha256"] }]).workerUpdates).toBe(1)
    entry.old.inputs.bindings = entry.new.inputs.bindings = [{ name: "SECRET", text: unknown }]
    rejects([{ ...entry, diffs: ["contentSha256"] }])
  })

  test("accepts only unconfigured optional-computed metadata with masked bindings", () => {
    const entry = script()
    entry.old.inputs.bindings = entry.new.inputs.bindings = [{ name: "SECRET", type: "secret_text", text: "[secret]" }]
    const proof = {
      ...entry,
      diffs: ["contentSha256", "placement"],
      detailedDiff: { placement: { diffKind: "add", inputDiff: false } },
    }
    expect(verifyConsoleUiDeploymentDiff([proof]).workerUpdates).toBe(1)
    rejects([{ ...proof, detailedDiff: { placement: { diffKind: "add", inputDiff: true } } }])
    rejects([{ ...proof, detailedDiff: null }])
    entry.old.inputs.placement = entry.new.inputs.placement = {}
    rejects([{ ...proof, old: entry.old, new: entry.new }])
  })

  test("permits identical local SecretV1 environment only with triggers-only provider proof", () => {
    const entry = builder()
    entry.old.inputs.environment = entry.new.inputs.environment = {
      SST: "1",
      SST_RESOURCE_Secret: {
        "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
        ciphertext: "[secret]",
      },
    }
    const proof = {
      ...entry,
      op: "replace",
      keys: ["triggers"],
      diffs: ["triggers"],
      detailedDiff: { "triggers[0]": { diffKind: "update-replace", inputDiff: true } },
    }
    expect(verifyConsoleUiDeploymentDiff([script(), proof]).builderUpdates).toBe(1)
    rejects([script(), { ...proof, diffs: undefined }])
    rejects([script(), { ...proof, diffs: ["triggers", "environment"] }])
    rejects([script(), { ...proof, detailedDiff: { "environment.SECRET": { diffKind: "update", inputDiff: true } } }])
    entry.old.inputs.environment = entry.new.inputs.environment = { TOKEN: unknown }
    rejects([script(), { ...proof, old: entry.old, new: entry.new }])
  })

  test("accepts noncustom component states without optional identity metadata", () => {
    const urn = `${prefix}pulumi:pulumi:Stack::mongolgpt-dev`
    expect(
      verifyConsoleUiDeploymentDiff([
        script(),
        {
          urn,
          type: "pulumi:pulumi:Stack",
          op: "update",
          old: { inputs: {}, outputs: {} },
          new: { inputs: {}, outputs: {} },
        },
      ]).workerUpdates,
    ).toBe(1)
  })

  test("permits explicit CI environment drift but preserves app settings and masked proof", () => {
    const entry = builder()
    entry.old.inputs.environment = {
      SST: "1",
      VITE_AUTH_URL: "https://auth.invalid",
      GITHUB_RUN_ID: "1",
      SST_RESOURCE_Secret: "[secret]",
    }
    entry.new.inputs.environment = {
      SST: "1",
      VITE_AUTH_URL: "https://auth.invalid",
      GITHUB_RUN_ID: "2",
      SST_RESOURCE_Secret: "[secret]",
      MONGOLGPT_RELEASE_SHA: "a".repeat(40),
      PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW: "true",
    }
    const proof = {
      ...entry,
      op: "replace",
      keys: ["triggers"],
      diffs: ["triggers", "environment"],
      detailedDiff: {
        "triggers[0]": { diffKind: "update-replace", inputDiff: true },
        "environment.GITHUB_RUN_ID": { diffKind: "update", inputDiff: true },
        "environment.MONGOLGPT_RELEASE_SHA": { diffKind: "add", inputDiff: true },
        "environment.PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW": { diffKind: "add", inputDiff: true },
      },
    }
    expect(verifyConsoleUiDeploymentDiff([script(), proof]).builderUpdates).toBe(1)
    rejects([script(), { ...proof, detailedDiff: undefined }])
    rejects([script(), { ...proof, detailedDiff: { environment: { diffKind: "update", inputDiff: true } } }])
    rejects([
      script(),
      {
        ...proof,
        detailedDiff: {
          ...proof.detailedDiff,
          "environment.SST_RESOURCE_Secret": { diffKind: "update", inputDiff: true },
        },
      },
    ])
    for (const key of [
      "VITE_AUTH_URL",
      "SST_RESOURCE_Secret",
      "SST_SECRET_KEY",
      "MONGOLGPT_GATEWAY_MODELS1",
      "PATH",
      "NODE_OPTIONS",
    ]) {
      const changed = structuredClone(proof)
      ;(changed.new.inputs.environment as Record<string, unknown>)[key] = "changed"
      rejects([script(), changed])
    }
    for (const [key, value] of [
      ["MONGOLGPT_RELEASE_SHA", "invalid"],
      ["PULUMI_TF_BRIDGE_ACCURATE_PF_BRIDGE_PREVIEW", "false"],
      ["RUNNER_TEMP", unknown],
    ]) {
      const changed = structuredClone(proof)
      ;(changed.new.inputs.environment as Record<string, unknown>)[key] = value
      rejects([script(), changed])
    }
  })

  test.each(["Database", "AuthApiScript", "PaymentServiceScript", "OtherWorker", "ConsoleWorkerDomain"])(
    "rejects out-of-scope %s updates",
    (name) => {
      rejects([script(), event(scriptType, name, worker, {})])
    },
  )

  test.each(["dev.mgpt.mn", "mgpt.mn", "www.mgpt.mn"])(
    "rejects domain mutation even for approved website %s",
    (hostname) => {
      rejects([
        script(),
        event("cloudflare:index/workersCustomDomain:WorkersCustomDomain", "ConsoleWorkerDomain", worker, {
          hostname,
          accountId,
          service: scriptName,
        }),
      ])
    },
  )

  test.each(["create", "delete", "replace", "create-replacement", "delete-replaced", "refresh", "read"])(
    "rejects worker operation %s",
    (op) => rejects([{ ...script(), op }]),
  )

  test("rejects wrong parent, provider, account, stage and spoofed nested URN", () => {
    const entry = script()
    rejects([{ ...entry, urn: entry.urn.replace("pulumi:dev", "pulumi:production") }])
    rejects([{ ...entry, new: { ...entry.new, parent: site } }])
    rejects([{ ...entry, new: { ...entry.new, provider: "other-provider" } }])
    rejects([{ ...entry, old: { ...entry.old, id: "" } }])
    const spoof = event(scriptType, "ConsoleWorkerScript", site, entry.old.inputs)
    spoof.new.inputs = entry.new.inputs
    rejects([spoof])
  })

  test("rejects malformed, empty, duplicate and oversized arrays", () => {
    for (const value of [
      null,
      {},
      "private-do-not-print",
      [],
      [null],
      [script(), script()],
      [url()],
      [{ ...script(), old: null }],
      [{ ...script(), new: { inputs: {} } }],
      Array(2001).fill(script()),
    ])
      rejects(value)
  })

  test("rejects unknown event, state, input, asset and metadata fields", () => {
    const entry = script()
    rejects([{ ...entry, unexpected: true }])
    rejects([{ ...entry, new: { ...entry.new, unexpected: true } }])
    entry.old.inputs.modules = entry.new.inputs.modules = []
    rejects([entry])
    const assets = script()
    assets.new.inputs.assets = { directory: "/repo/public", unknownField: true }
    rejects([assets])
    rejects([
      { ...script(), detailedDiff: { contentSha256: { diffKind: "update", inputDiff: true, unknownField: true } } },
    ])
  })

  test("checks diff metadata independently of old/new equality", () => {
    rejects([{ ...script(), diffs: ["bindings"] }])
    rejects([{ ...script(), keys: ["contentSha256"] }])
    rejects([{ ...script(), detailedDiff: { "assets.config.redirects": { diffKind: "update", inputDiff: true } } }])
    rejects([{ ...script(), detailedDiff: { etag: { diffKind: "update", inputDiff: true } } }])
    expect(
      verifyConsoleUiDeploymentDiff([
        {
          ...script(),
          diffs: ["contentSha256", "etag"],
          detailedDiff: { etag: { diffKind: "update", inputDiff: false } },
        },
      ]).workerUpdates,
    ).toBe(1)
  })

  test("does not blanket-approve stack outputs or same events", () => {
    const stack = event("pulumi:pulumi:Stack", "mongolgpt-dev", "", {}, false)
    stack.old.custom = stack.new.custom = false
    expect(verifyConsoleUiDeploymentDiff([script(), stack]).workerUpdates).toBe(1)
    stack.new.outputs = { WebsiteUrl: "https://other.invalid" }
    rejects([script(), stack])
    stack.new.outputs = { files: ["unexpected-ui-file"] }
    rejects([script(), stack])
    rejects([script(), { ...builder(), op: "same" }])
  })

  test("rejects changed URL enablement and provider serialization", () => {
    for (const key of ["enabled", "__provider", "accountId", "scriptName"]) {
      const entry = url()
      entry.new.inputs[key] = "private-do-not-print"
      rejects([script(), entry])
    }
  })

  test("wrapper prints only fixed reasons for malformed private JSON and validates a synthetic plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "console-ui-guard-"))
    try {
      const file = join(directory, "diff.json")
      const wrapper = fileURLToPath(new URL("../../../script/verify-console-ui-deployment.ts", import.meta.url))
      await Bun.write(file, '{"private-do-not-print":')
      const rejected = Bun.spawnSync([process.execPath, wrapper, file])
      expect(rejected.exitCode).toBe(1)
      expect(rejected.stdout.toString()).toBe("")
      expect(rejected.stderr.toString()).toContain('"reason":"invalid-preview"')
      expect(rejected.stderr.toString()).not.toContain("private-do-not-print")
      await Bun.write(file, JSON.stringify([script()]))
      const approved = Bun.spawnSync([process.execPath, wrapper, file])
      expect(approved.exitCode).toBe(0)
      expect(JSON.parse(approved.stdout.toString())).toEqual({ workerUpdates: 1, builderUpdates: 0, urlUpdates: 0 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
