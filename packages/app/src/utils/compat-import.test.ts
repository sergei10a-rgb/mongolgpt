import { describe, expect, test } from "bun:test"
import type { ServerSDK } from "@/context/server-sdk"
import { requestCompatImport, type CompatImportResponse } from "./compat-import"

const operation = {
  kind: "plugin" as const,
  source: "acme-plugin",
  spec: "./plugins/adapters/acme-plugin.compat.js",
  adapter: {
    file: "C:/project/.mongolgpt/plugins/adapters/acme-plugin.compat.js",
    target: "acme-plugin",
    format: "planned-js",
    original: "acme-plugin",
  },
}

function result(overrides: Partial<CompatImportResponse> = {}): CompatImportResponse {
  return {
    scope: "project",
    configPath: "C:/project/.mongolgpt/mongolgpt.jsonc",
    operations: [operation],
    prepared: [operation],
    descriptions: ["Plugin adapter"],
    warnings: [],
    outcomes: [{ mode: "add", operation }],
    existingConfigText: "{}",
    nextConfigText: '{"plugin":[]}',
    configExists: false,
    ...overrides,
  }
}

function sdk(
  response: Response,
  capture?: (path: string, init: RequestInit & { directory?: string }) => void,
): Pick<ServerSDK, "request"> {
  return {
    request: async (path, init) => {
      capture?.(path, init ?? {})
      return response
    },
  }
}

describe("compat import client contract", () => {
  test("sends the selected directory and accepts only a complete typed response", async () => {
    let request: { path: string; init: RequestInit & { directory?: string } } | undefined
    const payload = { type: "auto" as const, scope: "project" as const, source: "acme-plugin", adapter: true }
    const response = await requestCompatImport({
      sdk: sdk(Response.json(result()), (path, init) => {
        request = { path, init }
      }),
      mode: "plan",
      payload,
      directory: "C:/project",
    })

    expect(response).toEqual(result())
    expect(request?.path).toBe("/compat/import/plan")
    expect(request?.init.method).toBe("POST")
    expect(request?.init.directory).toBe("C:/project")
    const body = request?.init.body
    expect(typeof body).toBe("string")
    if (typeof body !== "string") throw new Error("Expected a JSON request body")
    expect(JSON.parse(body)).toEqual(payload)
  })

  test("uses the declared JSON error message without exposing unrelated fields", async () => {
    const message = "Нэмэлтийн entrypoint аюулгүй замаас гарсан байна"
    const response = new Response(JSON.stringify({ message, secret: "must-not-leak" }), {
      status: 400,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    })

    await expect(
      requestCompatImport({ sdk: sdk(response), mode: "apply", payload: { source: "unsafe-plugin" } }),
    ).rejects.toThrow(message)
  })

  test("fails closed on HTML, malformed JSON, and unrelated success payloads", async () => {
    const responses = [
      new Response("<!doctype html><title>secret shell</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      Response.json({ status: "ok" }),
      Response.json({
        ...result(),
        outcomes: [{ mode: "add", operation: { ...operation, adapter: { ...operation.adapter, file: 1 } } }],
      }),
    ]

    for (const response of responses) {
      const error = await requestCompatImport({
        sdk: sdk(response),
        mode: "plan",
        payload: { source: "source" },
      }).catch((failure) => failure)
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "MongolGPT сервер нийцтэй байдлын импортын зөв JSON хариу буцаасангүй.",
      )
      expect(String(error)).not.toContain("secret shell")
    }
  })

  test("uses a bounded generic error for non-JSON failures", async () => {
    const response = new Response("<html>private upstream diagnostic</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })
    const error = await requestCompatImport({ sdk: sdk(response), mode: "plan", payload: {} }).catch(
      (failure) => failure,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "Тохирлын импорт HTTP 502 төлөвөөр бүтэлгүйтлээ",
    )
    expect(String(error)).not.toContain("private upstream diagnostic")
  })
})
