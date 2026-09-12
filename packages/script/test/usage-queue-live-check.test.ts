import { expect, test } from "bun:test"
import { verifyDevUsageQueueHeartbeat } from "../src/usage-queue-live-check"

const timestamp = 1_789_000_000_000
const input = { accountId: "cc97ad90bfaf8a1da5de612eef2658f5", token: "private-token", notBefore: timestamp }
const valid = { version: 2, stage: "dev", id: "private-id", sentAt: timestamp, processedAt: timestamp }

function harness(responses: Array<() => Response | Promise<Response>>) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let time = timestamp
  return {
    requests,
    dependencies: {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms
      },
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init })
        return responses[Math.min(requests.length - 1, responses.length - 1)]()
      }) as typeof fetch,
    },
  }
}

test("requires post-deploy v2 evidence at the exact existing dev key and only GETs", async () => {
  const state = harness([() => new Response(null, { status: 404 }), () => Response.json(valid)])
  expect(await verifyDevUsageQueueHeartbeat(input, state.dependencies)).toEqual({
    stage: "dev",
    version: 2,
    freshAfterDeployment: true,
    attempts: 2,
  })
  expect(state.requests).toHaveLength(2)
  for (const request of state.requests) {
    expect(request.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/cc97ad90bfaf8a1da5de612eef2658f5/storage/kv/namespaces/edb0d61cd18a4dda889cf550ac00ab3f/values/usage-queue%3Adev%3Alast-processed",
    )
    expect(request.init?.method).toBe("GET")
    expect(request.init?.redirect).toBe("error")
    expect(request.init?.body).toBeUndefined()
  }
})

test("rejects stale, wrong-stage, malformed and impossible evidence with a bounded wait", async () => {
  for (const invalid of [
    { ...valid, version: 1 },
    { ...valid, stage: "production" },
    { ...valid, sentAt: timestamp - 1 },
    { ...valid, processedAt: timestamp - 1 },
    { ...valid, processedAt: timestamp + 60 * 60_000 },
    { ...valid, id: "" },
    { ...valid, extra: "private-decoy" },
    null,
  ]) {
    const state = harness([() => Response.json(invalid)])
    await expect(verifyDevUsageQueueHeartbeat(input, state.dependencies)).rejects.toThrow("No fresh dev v2")
    expect(state.requests).toHaveLength(32)
  }
  const malformed = harness([() => new Response("private-malformed-json")])
  await expect(verifyDevUsageQueueHeartbeat(input, malformed.dependencies)).rejects.toThrow("No fresh dev v2")
})

test("refuses invalid configuration and authorization errors without reading or reporting bodies", async () => {
  for (const invalid of [
    { ...input, accountId: "other" },
    { ...input, token: " " },
    { ...input, notBefore: timestamp + 1 },
    { ...input, notBefore: timestamp - 31 * 60_000 },
    { ...input, notBefore: NaN },
  ]) {
    const state = harness([() => Response.json(valid)])
    await expect(verifyDevUsageQueueHeartbeat(invalid, state.dependencies)).rejects.toThrow("Invalid dev queue")
    expect(state.requests).toHaveLength(0)
  }
  for (const status of [301, 400, 401, 403]) {
    const state = harness([() => new Response("private-error", { status })])
    await expect(verifyDevUsageQueueHeartbeat(input, state.dependencies)).rejects.toThrow("Cloudflare refused")
    expect(state.requests).toHaveLength(1)
  }
})

test("retries transient responses without leaking credentials or payloads", async () => {
  const state = harness([
    () => Promise.reject(new Error("private-token")),
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
    () => Response.json(valid),
  ])
  const result = await verifyDevUsageQueueHeartbeat(input, state.dependencies)
  expect(result.attempts).toBe(4)
  expect(JSON.stringify(result)).not.toMatch(/private-/)
})
