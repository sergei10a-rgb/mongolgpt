import { expect } from "bun:test"
import { Effect } from "effect"
import { createLocalBridgeGateway } from "../../../desktop/src/main/local-bridge-gateway"
import { localBridgeChallenge } from "../../../local-bridge/src/index"
import { cliIt } from "../lib/cli-process"

const origin = "https://app.dev.mgpt.mn"
const verifier = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
const state = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"
const password = "desktop-local-model-secret"
const providerID = "ollama-local"
const modelID = "local-model"
const reply = "Desktop локал загварын E2E амжилттай"

cliIt.live(
  "routes an Ollama-compatible model call through the authenticated Desktop bridge",
  ({ home, llm, mongolgpt }) =>
    Effect.gen(function* () {
      yield* llm.text(reply, { usage: { input: 11, output: 7 } })
      const sidecar = yield* mongolgpt.serve({
        hostname: "127.0.0.1",
        env: {
          MONGOLGPT_SERVER_USERNAME: "mongolgpt",
          MONGOLGPT_SERVER_PASSWORD: password,
          MONGOLGPT_CONFIG_CONTENT: JSON.stringify({
            formatter: false,
            lsp: false,
            provider: {
              [providerID]: {
                name: "Ollama (локал)",
                id: providerID,
                env: [],
                npm: "@ai-sdk/openai-compatible",
                models: {
                  [modelID]: {
                    id: modelID,
                    name: "Local Model",
                    attachment: false,
                    reasoning: false,
                    temperature: false,
                    tool_call: true,
                    release_date: "2025-01-01",
                    limit: { context: 100_000, output: 10_000 },
                    cost: { input: 0, output: 0 },
                    options: {},
                  },
                },
                options: { apiKey: "local-model", baseURL: llm.url },
              },
            },
          }),
        },
      })
      const gateway = createLocalBridgeGateway({
        sidecar: async () => ({ url: sidecar.url, username: "mongolgpt", password }),
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => gateway.stop()))

      const authorization = yield* Effect.promise(async () =>
        gateway.authorize({
          version: 1,
          origin,
          accountID: "usr_desktop_local_model",
          state,
          challenge: await localBridgeChallenge(verifier),
        }),
      )
      const base = `http://127.0.0.1:${authorization.port}`
      const exchange = yield* Effect.promise(() =>
        fetch(`${base}/bridge/v1/session`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ code: authorization.code, verifier }),
        }),
      )
      expect(exchange.status).toBe(200)
      const sessionToken = token(yield* Effect.promise(() => exchange.json()))
      const headers = {
        origin,
        authorization: `Basic ${Buffer.from(`bridge:${sessionToken}`).toString("base64")}`,
        "content-type": "application/json",
        "x-mongolgpt-directory": home,
      }

      const created = yield* Effect.promise(() =>
        fetch(`${base}/session`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Desktop local model E2E" }),
        }),
      )
      expect(created.status).toBe(200)
      const sessionID = identifier(yield* Effect.promise(() => created.json()))
      const prompted = yield* Effect.promise(() =>
        fetch(`${base}/session/${encodeURIComponent(sessionID)}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID, modelID },
            parts: [{ type: "text", text: "Локал загварыг шалга" }],
          }),
        }),
      )
      expect(prompted.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => prompted.json()))).toContain(reply)

      const messages = yield* Effect.promise(() =>
        fetch(`${base}/session/${encodeURIComponent(sessionID)}/message`, { headers }),
      )
      expect(messages.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => messages.json()))).toContain(reply)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.model).toBe(modelID)
      expect(Array.isArray(inputs[0]?.tools) && inputs[0].tools.length > 0).toBe(true)
    }),
  60_000,
)

function token(value: unknown) {
  if (!record(value) || typeof value.token !== "string") throw new Error("Desktop bridge session token missing")
  return value.token
}

function identifier(value: unknown) {
  if (!record(value) || typeof value.id !== "string") throw new Error("Desktop local-model session ID missing")
  return value.id
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
