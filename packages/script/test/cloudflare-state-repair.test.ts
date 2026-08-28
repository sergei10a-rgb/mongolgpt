import { describe, expect, test } from "bun:test"
import { auditCloudflareQueueProviderState, repairCloudflareQueueProviderState } from "../src/cloudflare-state-repair"

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
        metadata: {} as { integrity_error?: { error: string } },
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
    expect(result.rewired).toBe(1)
    expect(result.removedDuplicates).toBe(0)
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

  test("removes migrated duplicates, rewires remaining Cloudflare resources, and clears stale metadata", () => {
    const state = fixture()
    state.checkpoint.latest.metadata = { integrity_error: { error: `unknown provider ${oldProvider}` } }
    state.checkpoint.latest.resources.splice(1, 0, {
      urn: queueUrn,
      type: "cloudflare:index/queue:Queue",
      provider: `${newProviderUrn}::${newProviderId}`,
    })
    state.checkpoint.latest.resources.push({
      urn: "urn:pulumi:dev::mongolgpt::cloudflare:index/queueConsumer:QueueConsumer::UsageConsumer",
      type: "cloudflare:index/queueConsumer:QueueConsumer",
      provider: oldProvider,
    })

    const result = repairCloudflareQueueProviderState(state)

    expect(result).toMatchObject({ changed: true, rewired: 1, removedDuplicates: 1 })
    expect(state.checkpoint.latest.resources.filter((resource) => resource.urn === queueUrn)).toHaveLength(1)
    expect(state.checkpoint.latest.resources.at(-1)?.provider).toBe(`${newProviderUrn}::${newProviderId}`)
    expect(state.checkpoint.latest.metadata.integrity_error).toBeUndefined()
  })

  test("audits nested checkpoint copies without exposing unrelated values", () => {
    const state = fixture()
    state.checkpoint.latest.resources.push({
      urn: "urn:pulumi:dev::mongolgpt::example:index:Note::IntegrityMetadata",
      type: "example:index:Note",
      provider: `recorded failure: ${oldProvider}`,
    })

    expect(auditCloudflareQueueProviderState(state)).toEqual({
      targetProviders: [{ path: "$.checkpoint.latest.resources[1]", provider: oldProvider }],
      exactDanglingPaths: ["$.checkpoint.latest.resources[1].provider"],
      danglingMentionPaths: [
        "$.checkpoint.latest.resources[1].provider",
        "$.checkpoint.latest.resources[2].provider",
      ],
    })
  })

  test("fails closed when a non-Cloudflare resource references the removed provider", () => {
    const state = fixture()
    state.checkpoint.latest.resources.push({
      urn: "urn:pulumi:dev::mongolgpt::example:index:Thing::Unexpected",
      type: "example:index:Thing",
      provider: oldProvider,
    })

    expect(() => repairCloudflareQueueProviderState(state)).toThrow("Cloudflare бус resource")
  })

  test("fails closed without exactly one migrated provider", () => {
    const state = fixture()
    state.checkpoint.latest.resources.shift()

    expect(() => repairCloudflareQueueProviderState(state)).toThrow("яг нэг байх ёстой")
  })
})
