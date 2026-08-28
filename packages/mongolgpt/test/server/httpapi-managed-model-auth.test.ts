import { FSUtil } from "@mongolgpt/core/fs-util"
import { Database } from "@mongolgpt/core/database/database"
import { SessionV2 } from "@mongolgpt/core/session"
import { SessionMessage } from "@mongolgpt/core/session/message"
import { SessionInputTable, SessionTable } from "@mongolgpt/core/session/sql"
import { MessageID } from "@/session/schema"
import { Effect, Layer, Schema } from "effect"
import { afterEach, beforeEach, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, FSUtil.defaultLayer, Database.defaultLayer, httpApiLayer))
const model = { providerID: "mongolgpt", modelID: "free-auto" }
const unavailable = {
  providerID: model.providerID,
  modelID: model.modelID,
  message: `Загвар ашиглах боломжгүй байна: ${model.providerID}/${model.modelID}. Нийлүүлэгчийн холболт эсвэл MongolGPT аккаунтын нэвтрэлтийг шалгана уу.`,
}
const V2SessionResponse = Schema.Struct({
  data: Schema.Struct({ id: Schema.String, model: Schema.Unknown.pipe(Schema.optional) }),
})
const LegacySessionResponse = Schema.Struct({ id: Schema.String })

const config = {
  formatter: false,
  lsp: false,
  provider: {
    mongolgpt: {
      name: "MongolGPT",
      npm: "@ai-sdk/openai-compatible",
      api: "https://gateway.example/v1",
      models: {
        "free-auto": {
          name: "MongolGPT Free Auto",
          cost: { input: 0, output: 0 },
          tool_call: true,
          limit: { context: 32_000, output: 4_096 },
        },
      },
      options: { apiKey: "service-key-without-account" },
    },
  },
}

const accountEnv = ["MONGOLGPT_RUNTIME_MODE", "MONGOLGPT_API_KEY", "MONGOLGPT_AUTH_CONTENT"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of accountEnv) {
    originalEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
})

it.instance(
  "rejects account-gated Free Auto before every session model mutation",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const headers = { "x-mongolgpt-directory": test.directory, "content-type": "application/json" }

      const availableModels = yield* request("/api/model", { headers })
      const availableModelBody = yield* availableModels.json
      expect(JSON.stringify(availableModelBody)).not.toContain("free-auto")

      const v2Create = yield* request("/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: { providerID: model.providerID, id: model.modelID },
          location: { directory: test.directory },
        }),
      })
      expect(v2Create.status).toBe(404)
      expect(yield* v2Create.json).toEqual({ _tag: "ModelUnavailableError", ...unavailable })

      const v2SessionResponse = yield* request("/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ location: { directory: test.directory } }),
      })
      const v2Session = yield* Schema.decodeUnknownEffect(V2SessionResponse)(yield* v2SessionResponse.json)
      const v2Switch = yield* request(`/api/session/${v2Session.data.id}/model`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { providerID: model.providerID, id: model.modelID } }),
      })
      expect(v2Switch.status).toBe(404)
      expect(yield* v2Switch.json).toEqual({ _tag: "ModelUnavailableError", ...unavailable })

      const v2Current = yield* request(`/api/session/${v2Session.data.id}`, { headers })
      expect((yield* Schema.decodeUnknownEffect(V2SessionResponse)(yield* v2Current.json)).data.model).toBeUndefined()

      const v2SessionID = SessionV2.ID.make(v2Session.data.id)
      yield* Database.Service.use(({ db }) =>
        db
          .update(SessionTable)
          .set({ model: { providerID: model.providerID, id: model.modelID } })
          .where(eq(SessionTable.id, v2SessionID))
          .run()
          .pipe(Effect.orDie),
      )
      const v2Prompt = yield* request(`/api/session/${v2Session.data.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_account_gate", prompt: { text: "hello" } }),
      })
      expect(v2Prompt.status).toBe(404)
      expect(yield* v2Prompt.json).toEqual({ _tag: "ModelUnavailableError", ...unavailable })
      const admitted = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_account_gate")))
          .get()
          .pipe(Effect.orDie),
      )
      expect(admitted).toBeUndefined()

      const legacyCreate = yield* request("/session", { method: "POST", headers, body: "{}" })
      const legacySession = yield* Schema.decodeUnknownEffect(LegacySessionResponse)(yield* legacyCreate.json)
      const paths = [
        {
          path: "/session",
          body: { model: { providerID: model.providerID, id: model.modelID } },
        },
        {
          path: `/session/${legacySession.id}/init`,
          body: { ...model, messageID: MessageID.ascending() },
        },
        { path: `/session/${legacySession.id}/summarize`, body: model },
        {
          path: `/session/${legacySession.id}/message`,
          body: { model, parts: [{ type: "text", text: "hello" }] },
        },
        {
          path: `/session/${legacySession.id}/prompt_async`,
          body: { model, parts: [{ type: "text", text: "hello" }] },
        },
        {
          path: `/session/${legacySession.id}/command`,
          body: { model: `${model.providerID}/${model.modelID}`, command: "init", arguments: "" },
        },
        {
          path: `/session/${legacySession.id}/shell`,
          body: { model, agent: "build", command: "echo test" },
        },
      ]

      for (const input of paths) {
        const response = yield* request(input.path, {
          method: "POST",
          headers,
          body: JSON.stringify(input.body),
        })
        expect(response.status).toBe(404)
        expect(yield* response.json).toEqual({ _tag: "ModelNotFoundError", suggestions: [], ...unavailable })
      }

      const messages = yield* request(`/session/${legacySession.id}/message`, { headers })
      expect(yield* messages.json).toEqual([])
    }),
  { git: true, config },
  30_000,
)
