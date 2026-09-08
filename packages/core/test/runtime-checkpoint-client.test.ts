import { describe, expect, test } from "bun:test"
import { checkpointControlHeader } from "@mongolgpt/runtime-auth/control"
import { RuntimeCheckpointClient } from "../src/runtime-checkpoint-client"

const token = "a".repeat(64)
const origin = "http://checkpoint.mongolgpt.internal"
const paths = ["/v1/bootstrap", "/v1/begin", "/v1/archive", "/v1/publish", "/v1/publish-files", "/v1/upload"]

describe("RuntimeCheckpointClient", () => {
  test("adds the checkpoint control header only for the exact checkpoint POST allowlist", async () => {
    const seen: Request[] = []
    const request = RuntimeCheckpointClient.create(token, async (input) => {
      seen.push(input)
      return new Response("ok")
    })

    for (const path of paths) {
      const response = await request(new Request(`${origin}${path}`, { method: "POST" }))
      expect(await response.text()).toBe("ok")
    }

    expect(seen.map((input) => new URL(input.url).pathname)).toEqual(paths)
    expect(seen.every((input) => input.headers.get(checkpointControlHeader) === token)).toBe(true)
    expect(seen.every((input) => input.redirect === "error")).toBe(true)
  })

  test("rejects invalid methods, origins, URL decorations, and token values before transport", async () => {
    expect(() => RuntimeCheckpointClient.create("A".repeat(64))).toThrow("Invalid runtime checkpoint control token.")
    expect(() => RuntimeCheckpointClient.create(`${"a".repeat(63)}g`)).toThrow(
      "Invalid runtime checkpoint control token.",
    )

    let calls = 0
    const request = RuntimeCheckpointClient.create(token, async () => {
      calls++
      return new Response("unexpected")
    })
    const rejected = [
      new Request(`${origin}/v1/bootstrap`, { method: "GET" }),
      new Request("https://checkpoint.mongolgpt.internal/v1/bootstrap", { method: "POST" }),
      new Request("http://checkpoint.mongolgpt.internal.evil/v1/bootstrap", { method: "POST" }),
      new Request("http://user@checkpoint.mongolgpt.internal/v1/bootstrap", { method: "POST" }),
      new Request(`${origin}/v1/bootstrap?token=${token}`, { method: "POST" }),
      new Request(`${origin}/v1/bootstrap#${token}`, { method: "POST" }),
      new Request(`${origin}/v1/bootstrap?`, { method: "POST" }),
      new Request(`${origin}/v1/bootstrap#`, { method: "POST" }),
      new Request(`${origin}/v1/unknown`, { method: "POST" }),
    ]

    for (const input of rejected) await expect(request(input)).rejects.toThrow("Invalid runtime checkpoint request.")
    expect(calls).toBe(0)
  })

  test("clones headers and request body without mutating or consuming the input request", async () => {
    let forwarded!: Request
    const input = new Request(`${origin}/v1/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-original": "yes" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stream upload"))
          controller.close()
        },
      }),
    })
    const request = RuntimeCheckpointClient.create(token, async (next) => {
      forwarded = next
      return new Response("ok")
    })

    await request(input)

    expect(input.bodyUsed).toBe(false)
    expect(input.headers.get(checkpointControlHeader)).toBeNull()
    expect(forwarded).not.toBe(input)
    expect(forwarded.headers.get("x-original")).toBe("yes")
    expect(forwarded.headers.get(checkpointControlHeader)).toBe(token)
    expect(await forwarded.text()).toBe("stream upload")
  })

  test("cancels redirected responses and reports a sanitized failure", async () => {
    let cancelled = false
    const request = RuntimeCheckpointClient.create(token, async () => {
      const response = new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      )
      Object.defineProperty(response, "redirected", { value: true })
      return response
    })

    const error = await request(new Request(`${origin}/v1/bootstrap`, { method: "POST" })).catch((cause) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Runtime checkpoint request failed.")
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })

  test("redacts transport failures without leaking URLs or tokens", async () => {
    for (const thrown of [
      new Error(`failed ${origin}/v1/bootstrap ${token}`),
      new RuntimeCheckpointClient.RuntimeCheckpointClientError(`malicious ${token}`),
    ]) {
      const request = RuntimeCheckpointClient.create(token, async () => {
        throw thrown
      })

      const error = await request(new Request(`${origin}/v1/bootstrap`, { method: "POST" })).catch((cause) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Runtime checkpoint request failed.")
      expect((error as Error).message).not.toContain(token)
      expect((error as Error).message).not.toContain("checkpoint.mongolgpt.internal")
    }
  })
})
