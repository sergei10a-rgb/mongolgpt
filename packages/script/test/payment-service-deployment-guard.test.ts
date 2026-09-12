import { describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  PaymentServiceDeploymentGuardError,
  verifyPaymentServiceDeploymentDiff,
  verifyUsageQueueDeploymentDiff,
} from "../src/usage-queue-deployment-guard"

const accountId = "cc97ad90bfaf8a1da5de612eef2658f5"
const workerType = "cloudflare:index/workersScript:WorkersScript"
const urlType = "pulumi-nodejs:dynamic:Resource"
const oldHash = "a".repeat(64)
const newHash = "b".repeat(64)
const privateValue = "private-do-not-print"
const unknownString = "04da6b54-80e4-46f7-96ec-b56ff0331ba9"
const scriptName = "mongolgpt-dev-paymentservicescript"

describe("payment service deployment guard", () => {
  test("permits exactly the PaymentService worker code and URL etag update", () => {
    expect(verifyPaymentServiceDeploymentDiff([worker(), url()])).toEqual({ workerUpdates: 1, urlUpdates: 1 })
    expect(
      verifyPaymentServiceDeploymentDiff([
        worker(),
        url(),
        stack(),
        same("sst:cloudflare:Worker", "PaymentService"),
        providerMetadata(),
      ]),
    ).toEqual({ workerUpdates: 1, urlUpdates: 1 })
  })

  test("rejects no-op, partial, duplicate, destructive, and out-of-scope plans", () => {
    rejects([])
    rejects([worker()])
    rejects([url()])
    rejects([worker(), url(), worker()])
    rejects([{ ...worker(), op: "create" }])
    rejects([{ ...worker(), op: "delete" }])
    rejects([{ ...worker(), op: "replace" }])
    rejects([worker("ConsoleWorkerScript"), url()])
    rejects([worker(), url("ConsoleWorkerUrl.sst.cloudflare.WorkerUrl")])
    rejects(mutating("cloudflare:index/workersSecret:WorkersSecret", "PaymentServiceSecret", "update"))
    rejects(mutating("pulumi-nodejs:dynamic:Resource", "QuotaServiceUrl.sst.cloudflare.WorkerUrl", "update"))
  })

  test("rejects the actual broader six-event payment preview shape", () => {
    rejects([
      worker(),
      url(),
      worker("ConsoleWorkerScript", { stablePatch: { bindings: [{ name: "SECRET", text: privateValue }] } }),
      url("ConsoleWorkerUrl.sst.cloudflare.WorkerUrl"),
      mutating("cloudflare:index/workersScript:WorkersScript", "OldConsoleWorkerScript", "delete"),
      mutating("pulumi-nodejs:dynamic:Resource", "OldConsoleWorkerUrl.sst.cloudflare.WorkerUrl", "delete"),
    ])
  })

  test("rejects wrong stage, stack, account, logical name, or physical script name", () => {
    rejects([{ ...worker(), urn: worker().urn.replace("pulumi:dev", "pulumi:prod") }, url()])
    rejects([{ ...worker(), urn: worker().urn.replace("::mongolgpt::", "::mongolgpt-admin::") }, url()])
    rejects([worker("PaymentService"), url()])
    rejects([worker("PaymentServiceScript", { scriptName: "wrong-script" }), url()])
    rejects([worker("PaymentServiceScript", { accountId: "wrong-account" }), url()])
  })

  test("rejects worker settings, bindings, masked binding, and engine proof mutations", () => {
    rejects([worker("PaymentServiceScript", { stablePatch: { compatibilityDate: "2026-01-02" } }), url()])
    rejects([worker("PaymentServiceScript", { stablePatch: { bindings: [{ name: "NEW" }] } }), url()])
    rejects([worker("PaymentServiceScript", { newContentSha256: "not-a-64-hex-hash" }), url()])
    rejects([worker("PaymentServiceScript", { newContentSha256: oldHash }), url()])
    rejects([worker("PaymentServiceScript", { deleteInput: "contentFile" }), url()])
    rejects([worker("PaymentServiceScript", { addInput: ["unexpected", "value"] }), url()])

    const redacted = worker()
    const bindings = { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", ciphertext: "[secret]" }
    rejects([
      {
        ...redacted,
        diffs: ["contentSha256", "bindings"],
        old: { ...redacted.old, inputs: { ...redacted.old!.inputs, bindings } },
        new: { ...redacted.new, inputs: { ...redacted.new!.inputs, bindings } },
      },
      url(),
    ])
  })

  test("accepts only the known optional-computed worker proof", () => {
    const entry = worker()
    const detailedDiff = {
      contentSha256: { diffKind: "update", inputDiff: false },
      annotations: { diffKind: "add", inputDiff: false },
      placement: { diffKind: "add", inputDiff: false },
      tailConsumers: { diffKind: "add", inputDiff: false },
    }
    const bindings = { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", ciphertext: "[secret]" }
    const preview = {
      ...entry,
      diffs: Object.keys(detailedDiff),
      detailedDiff,
      old: { ...entry.old, inputs: { ...entry.old!.inputs, bindings } },
      new: { ...entry.new, inputs: { ...entry.new!.inputs, bindings } },
    }
    expect(verifyPaymentServiceDeploymentDiff([preview, url()])).toEqual({ workerUpdates: 1, urlUpdates: 1 })
    rejects([{ ...preview, detailedDiff: { ...detailedDiff, placement: { diffKind: "add", inputDiff: true } } }, url()])
    rejects([{ ...preview, old: { ...preview.old, inputs: { ...preview.old!.inputs, placement: {} } } }, url()])
    rejects([{ ...preview, diffs: [...preview.diffs, "bindings"] }, url()])
  })

  test("rejects URL settings, wrong worker, opaque proof, and unchanged etag", () => {
    rejects([worker(), url("PaymentServiceUrl.sst.cloudflare.WorkerUrl", { stablePatch: { enabled: false } })])
    rejects([worker(), url("PaymentServiceUrl.sst.cloudflare.WorkerUrl", { stablePatch: { scriptName: "wrong" } })])
    rejects([worker(), url("PaymentServiceUrl.sst.cloudflare.WorkerUrl", { stablePatch: { accountId: "wrong" } })])
    rejects([worker(), url("PaymentServiceUrl.sst.cloudflare.WorkerUrl", { newEtag: "old-etag" })])
    rejects([worker(), url("PaymentServiceUrl.sst.cloudflare.WorkerUrl", { newEtag: "" })])
    rejects([worker(), url("PaymentServiceUrl.sst.cloudflare.WorkerUrl", { opaque: true })])
  })

  test("rejects queue heartbeat LinkRef mutation in payment mode", () => {
    expect(verifyUsageQueueDeploymentDiff([heartbeatLink()])).toEqual({ workerUpdates: 0, urlUpdates: 0 })
    rejects([worker(), url(), heartbeatLink()])
  })

  test("reports finite failure reasons and hides unexpected input exceptions", () => {
    for (const [input, reason] of [
      [[], "incomplete-deployment-plan"],
      [[worker(), url(), mutating(workerType, "private-outside", "delete")], "invalid-entry"],
      [
        [
          {
            get urn() {
              throw new Error(privateValue)
            },
          },
        ],
        "invalid-preview",
      ],
    ] as const) {
      try {
        verifyPaymentServiceDeploymentDiff(input)
        throw new Error("Expected rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(PaymentServiceDeploymentGuardError)
        expect((error as PaymentServiceDeploymentGuardError).reason).toBe(reason)
        expect(String(error)).not.toContain(privateValue)
      }
    }
  })

  test("rejects malformed previews, oversized arrays, and missing state proof", () => {
    for (const invalid of [
      null,
      {},
      [null],
      [{}],
      Array.from({ length: 2_001 }, () => same("sst:cloudflare:Worker", crypto.randomUUID())),
      [worker("PaymentServiceScript", { omitOldState: true }), url()],
      [worker("PaymentServiceScript", { omitInputs: true }), url()],
      [worker("PaymentServiceScript", { opaque: true }), url()],
    ])
      expect(() => verifyPaymentServiceDeploymentDiff(invalid)).toThrow(PaymentServiceDeploymentGuardError)
  })

  test("throws one fixed private-safe payment error", () => {
    const entry = worker("PaymentServiceScript", {
      stablePatch: { bindings: [{ name: "SECRET", text: privateValue }] },
    })
    try {
      verifyPaymentServiceDeploymentDiff([entry, url()])
      throw new Error("expected payment deployment rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentServiceDeploymentGuardError)
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "Dev payment service deployment preview is not approved",
      )
      expect(String(error)).not.toContain(privateValue)
      expect(JSON.stringify(error)).not.toContain(privateValue)
    }
  })

  test("actual CLI rejects private, malformed, wrong-stage, and oversized input without printing details", async () => {
    const file = join(tmpdir(), `mongolgpt-payment-verify-${crypto.randomUUID()}.json`)
    const script = resolve(import.meta.dir, "../../../script/verify-payment-service-deployment.ts")
    try {
      for (const input of [
        JSON.stringify([worker(), url()]),
        JSON.stringify([
          worker("PaymentServiceScript", { stablePatch: { bindings: [{ text: privateValue }] } }),
          url(),
        ]),
        '{"private-secret":"unterminated',
        JSON.stringify([{ ...worker(), urn: worker().urn.replace("pulumi:dev", "pulumi:prod") }, url()]),
      ]) {
        await Bun.write(file, input)
        const child = Bun.spawn([process.execPath, script, file], { stdout: "pipe", stderr: "pipe" })
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        const status = await child.exited
        expect(stdout + stderr).not.toMatch(/private-|SECRET|ConsoleWorkerScript|wrong-script/)
        if (input === JSON.stringify([worker(), url()])) {
          expect(status).toBe(0)
          expect(JSON.parse(stdout)).toEqual({ workerUpdates: 1, urlUpdates: 1 })
          expect(stderr).toBe("")
          continue
        }
        expect(status).toBe(1)
        expect(stdout).toBe("")
        expect(stderr.trim().split(/\r?\n/)[0]).toBe(
          "Dev payment service deployment rejected; private diff content was not printed.",
        )
        expect(JSON.parse(stderr.trim().split(/\r?\n/)[1])).toMatchObject({ approved: false })
      }

      await Bun.write(file, " ".repeat(16 * 1024 * 1024 + 1))
      for (const args of [[file], [], [file, "private-extra-argument"], [`${file}-missing`]]) {
        const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
        const stdout = await new Response(child.stdout).text()
        const stderr = await new Response(child.stderr).text()
        expect(await child.exited).toBe(1)
        expect(stdout).toBe("")
        expect(stderr.trim().split(/\r?\n/)[0]).toBe(
          "Dev payment service deployment rejected; private diff content was not printed.",
        )
        expect(JSON.parse(stderr.trim().split(/\r?\n/)[1])).toEqual({ approved: false, reason: "invalid-preview" })
        expect(stderr).not.toContain(file)
        expect(stderr).not.toContain("private-extra-argument")
      }
    } finally {
      await unlink(file)
    }
  })
})

function rejects(value: unknown) {
  expect(() => verifyPaymentServiceDeploymentDiff(Array.isArray(value) ? value : [value])).toThrow(
    PaymentServiceDeploymentGuardError,
  )
}

function worker(
  name = "PaymentServiceScript",
  options: {
    accountId?: string
    scriptName?: string
    newContentSha256?: string
    stablePatch?: Record<string, unknown>
    addInput?: [string, unknown]
    deleteInput?: string
    opaque?: boolean
    omitOldState?: boolean
    omitNewState?: boolean
    omitInputs?: boolean
    oldStatePatch?: Record<string, unknown>
    newStatePatch?: Record<string, unknown>
  } = {},
) {
  const type = workerType
  const urn = urnFor(type, name)
  const oldInputs = {
    accountId: options.accountId ?? accountId,
    scriptName: options.scriptName ?? scriptName,
    contentFile: "old-worker.js",
    contentSha256: oldHash,
    compatibilityDate: "2026-09-01",
    bindings: [{ type: "plain_text", name: "ENV", text: "dev" }],
    __provider: "provider-ref",
  } as Record<string, unknown>
  const newInputs: Record<string, unknown> = {
    ...oldInputs,
    contentFile: "new-worker.js",
    contentSha256: options.newContentSha256 ?? newHash,
    ...options.stablePatch,
  }
  if (options.addInput) newInputs[options.addInput[0]] = options.addInput[1]
  if (options.deleteInput) delete newInputs[options.deleteInput]
  if (options.opaque) newInputs.bindings = [{ type: "plain_text", value: { __pulumiUnknown: true } }]
  return {
    urn,
    type,
    op: "update",
    detailedDiff: { contentSha256: { diffKind: "update", inputDiff: false } },
    old: options.omitOldState
      ? undefined
      : state(urn, type, options.omitInputs ? undefined : oldInputs, options.oldStatePatch),
    new: options.omitNewState
      ? undefined
      : state(urn, type, options.omitInputs ? undefined : newInputs, options.newStatePatch),
  }
}

function url(
  name = "PaymentServiceUrl.sst.cloudflare.WorkerUrl",
  options: {
    stablePatch?: Record<string, unknown>
    newEtag?: string
    opaque?: boolean
  } = {},
) {
  const urn = urnFor(urlType, name)
  const oldInputs = { accountId, scriptName, enabled: true, etag: "old-etag" }
  const newInputs = { ...oldInputs, etag: options.newEtag ?? "new-etag", ...options.stablePatch }
  if (options.opaque) newInputs.etag = "[unknown]"
  return {
    urn,
    type: urlType,
    op: "update",
    old: state(urn, urlType, oldInputs),
    new: state(urn, urlType, newInputs),
  }
}

function providerMetadata() {
  const type = "pulumi:providers:pulumi-nodejs"
  const urn = urnFor(type, "default")
  return {
    urn,
    type,
    op: "update",
    old: state(urn, type, {}),
    new: state(urn, type, { "cloudflare:version": "6.15.0", "random:version": "4.19.2" }),
  }
}

function stack() {
  return { urn: urnFor("pulumi:pulumi:Stack", "mongolgpt-dev"), type: "pulumi:pulumi:Stack", op: "update" }
}

function heartbeatLink() {
  const type = "sst:sst:LinkRef"
  const urn = urnFor(type, "UsageQueueHeartbeatHandlerLinkRef")
  const include = [
    {
      type: "cloudflare.binding",
      binding: "serviceBindings",
      properties: { service: "mongolgpt-dev-usagequeueheartbeathandlerscript" },
    },
  ]
  return {
    urn,
    type,
    op: "update",
    old: { urn, type, custom: false, inputs: { properties: {}, include } },
    new: { urn, type, custom: false, inputs: { properties: { url: unknownString }, include } },
  }
}

function same(type: string, name: string) {
  return { urn: urnFor(type, name), type, op: "same" }
}

function mutating(type: string, name: string, op: string) {
  const urn = urnFor(type, name)
  return { urn, type, op, old: state(urn, type, {}), new: state(urn, type, {}) }
}

function urnFor(type: string, name: string) {
  return `urn:pulumi:dev::mongolgpt::${type}::${name}`
}

function state(
  urn: string,
  type: string,
  inputs: Record<string, unknown> | undefined,
  patch: Record<string, unknown> = {},
) {
  return { urn, type, id: `${type}::id`, provider: "provider-ref", inputs, ...patch }
}
