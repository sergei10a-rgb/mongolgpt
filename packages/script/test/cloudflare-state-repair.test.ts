import { describe, expect, test } from "bun:test"
import { repairCloudflareQueueProviderState } from "../src/cloudflare-state-repair"

const oldProvider =
  "urn:pulumi:dev::mongolgpt::pulumi:providers:cloudflare::default_6_13_0::9a45bc90-e476-4ef5-9e66-8febc7016477"
const newProviderUrn = "urn:pulumi:dev::mongolgpt::pulumi:providers:cloudflare::default_6_14_0"
const newProviderId = "8f3ef980-9e5e-4b75-b893-a3eed0f1a098"
const queueUrn = "urn:pulumi:dev::mongolgpt::sst:cloudflare:Queue$cloudflare:index/queue:Queue::UsageQueueQueue"

function fixture() {
  return {
    version: 3,
    checkpoint: {
      latest: {
        resources: [
          { urn: newProviderUrn, type: "pulumi:providers:cloudflare", id: newProviderId },
          { urn: queueUrn, type: "cloudflare:index/queue:Queue", provider: oldProvider },
        ],
      },
    },
  }
}

describe("Cloudflare queue provider state repair", () => {
  test("rewires only the dangling UsageQueue provider to the migrated provider", () => {
    const state = fixture()
    const result = repairCloudflareQueueProviderState(state)

    expect(result.changed).toBe(true)
    expect(state.checkpoint.latest.resources[1].provider).toBe(`${newProviderUrn}::${newProviderId}`)
    expect(state.checkpoint.latest.resources[0]).toEqual({
      urn: newProviderUrn,
      type: "pulumi:providers:cloudflare",
      id: newProviderId,
    })
  })

  test("is idempotent after the exact repair has been applied", () => {
    const state = fixture()
    repairCloudflareQueueProviderState(state)

    expect(repairCloudflareQueueProviderState(state).changed).toBe(false)
  })

  test("fails closed when another resource also references the removed provider", () => {
    const state = fixture()
    state.checkpoint.latest.resources.push({
      urn: "urn:pulumi:dev::mongolgpt::cloudflare:index/kvNamespace:KvNamespace::Unexpected",
      type: "cloudflare:index/kvNamespace:KvNamespace",
      provider: oldProvider,
    })

    expect(() => repairCloudflareQueueProviderState(state)).toThrow("жагсаалт хүлээлтээс зөрлөө")
  })

  test("fails closed without exactly one migrated provider", () => {
    const state = fixture()
    state.checkpoint.latest.resources.shift()

    expect(() => repairCloudflareQueueProviderState(state)).toThrow("яг нэг байх ёстой")
  })
})
