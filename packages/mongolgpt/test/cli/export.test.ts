import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import path from "node:path"
import { SessionV1 } from "@mongolgpt/core/v1/session"
import { Session } from "../../src/session/session"
import { sanitize } from "../../src/cli/cmd/export"
import { cliIt } from "../lib/cli-process"

const privateValue = "synthetic-private-export-value"
const apiError: SessionV1.APIError = {
  name: "APIError",
  data: {
    message: privateValue,
    statusCode: 429,
    isRetryable: false,
    responseHeaders: { "set-cookie": privateValue, [privateValue]: "header-value" },
    responseBody: JSON.stringify({ prompt: privateValue }),
    metadata: { url: `https://example.invalid/?token=${privateValue}`, [privateValue]: "metadata-value" },
  },
}

function fixture(error?: SessionV1.Assistant["error"]): Parameters<typeof sanitize>[0] {
  const sessionID = Session.Info.fields.id.make("ses_export_test")
  return {
    info: {
      id: sessionID,
      slug: "export-test",
      projectID: Session.Info.fields.projectID.make("export-test"),
      directory: "/synthetic/project",
      title: "Export fixture",
      version: "test",
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        info: {
          id: SessionV1.MessageID.make("msg_export_test"),
          sessionID,
          role: "assistant",
          parentID: SessionV1.MessageID.make("msg_export_user"),
          time: { created: 1, completed: 2 },
          providerID: SessionV1.Assistant.fields.providerID.make("test"),
          modelID: SessionV1.Assistant.fields.modelID.make("test-model"),
          mode: "build",
          agent: "build",
          path: { cwd: "/synthetic/project", root: "/synthetic/project" },
          cost: 0,
          tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          error,
        },
        parts: [],
      },
    ],
  }
}

function validate(result: ReturnType<typeof sanitize>) {
  const json = JSON.stringify(result)
  expect(json).not.toContain(privateValue)
  expect(Schema.is(Session.Info)(result.info)).toBe(true)
  for (const message of result.messages) expect(Schema.is(SessionV1.WithParts)(message)).toBe(true)
}

describe("sanitized session export errors", () => {
  test("redacts API payloads and map keys while preserving diagnostic status", () => {
    const result = sanitize(fixture(apiError))
    validate(result)
    expect(result.messages[0].info).toMatchObject({
      role: "assistant",
      error: { name: "APIError", data: { statusCode: 429, isRetryable: false } },
    })
  })

  const errors: NonNullable<SessionV1.Assistant["error"]>[] = [
    { name: "ProviderAuthError", data: { providerID: privateValue, message: privateValue } },
    { name: "UnknownError", data: { message: privateValue, ref: privateValue } },
    { name: "MessageAbortedError", data: { message: privateValue } },
    { name: "StructuredOutputError", data: { message: privateValue, retries: 2 } },
    { name: "ContextOverflowError", data: { message: privateValue, responseBody: privateValue } },
    { name: "ContentFilterError", data: { message: privateValue } },
    { name: "MessageOutputLengthError", data: {} },
  ]
  for (const error of errors) {
    test(`redacts ${error.name} without changing its schema`, () => {
      const result = sanitize(fixture(error))
      validate(result)
      expect(result.messages[0].info).toMatchObject({ error: { name: error.name } })
      if (error.name === "StructuredOutputError") {
        expect(result.messages[0].info).toMatchObject({ error: { data: { retries: 2 } } })
      }
    })
  }

  test("redacts retry errors without losing attempts and timestamps", () => {
    const input = fixture()
    input.messages[0].parts.push({
      id: SessionV1.PartID.make("prt_export_retry"),
      sessionID: input.info.id,
      messageID: input.messages[0].info.id,
      type: "retry",
      attempt: 2,
      time: { created: 3 },
      error: apiError,
    })
    const result = sanitize(input)
    validate(result)
    expect(result.messages[0].parts[0]).toMatchObject({
      type: "retry",
      attempt: 2,
      time: { created: 3 },
      error: { name: "APIError", data: { statusCode: 429, isRetryable: false } },
    })
  })

  test("redacts failed tool messages alongside inputs and metadata", () => {
    const input = fixture()
    input.messages[0].parts.push({
      id: SessionV1.PartID.make("prt_export_tool"),
      sessionID: input.info.id,
      messageID: input.messages[0].info.id,
      type: "tool",
      tool: "bash",
      callID: "call_export_test",
      state: {
        status: "error",
        error: `Command failed: ${privateValue}`,
        input: { command: privateValue },
        metadata: { output: privateValue },
        time: { start: 1, end: 2 },
      },
    })
    const result = sanitize(input)
    validate(result)
    expect(result.messages[0].parts[0]).toMatchObject({
      type: "tool",
      tool: "bash",
      state: { status: "error", time: { start: 1, end: 2 } },
    })
  })

  test("preserves absent optional fields and does not mutate the raw export", () => {
    const input = fixture({ name: "APIError", data: { message: privateValue, isRetryable: true } })
    const before = JSON.stringify(input)
    const result = sanitize(input)
    validate(result)
    expect(JSON.stringify(input)).toBe(before)
    expect(JSON.stringify(result)).not.toContain("responseHeaders")
    expect(JSON.stringify(result)).not.toContain("responseBody")
    expect(JSON.stringify(result)).not.toContain("metadata")
    expect(JSON.stringify(result)).not.toContain("statusCode")
  })

  test("preserves a successful message without inventing an error", () => {
    const input = fixture()
    const result = sanitize(input)
    validate(result)
    expect(JSON.stringify(result)).not.toContain('"error"')
    expect(result.messages[0].info).toMatchObject({
      id: input.messages[0].info.id,
      providerID: "test",
      cost: 0,
      tokens: { input: 4, output: 2 },
    })
  })

  cliIt.live(
    "imports and exports errors through the real CLI without changing stored history",
    ({ home, mongolgpt }) =>
      Effect.gen(function* () {
        const input = fixture(apiError)
        const message = input.messages[0]
        message.parts.push(
          {
            id: SessionV1.PartID.make("prt_export_retry"),
            sessionID: input.info.id,
            messageID: message.info.id,
            type: "retry",
            attempt: 1,
            time: { created: 1 },
            error: apiError,
          },
          {
            id: SessionV1.PartID.make("prt_export_tool"),
            sessionID: input.info.id,
            messageID: message.info.id,
            type: "tool",
            tool: "bash",
            callID: "call_export_test",
            state: {
              status: "error",
              input: {},
              error: privateValue,
              time: { start: 1, end: 2 },
            },
          },
        )
        const filename = path.join(home, "synthetic-export.json")
        yield* Effect.promise(() => Bun.write(filename, JSON.stringify(input)))
        const imported = yield* mongolgpt.spawn(["import", filename])
        mongolgpt.expectExit(imported, 0, "import synthetic errors")
        expect(imported.stdout).toContain(input.info.id)

        const raw = yield* mongolgpt.spawn(["export", input.info.id])
        mongolgpt.expectExit(raw, 0, "raw export")
        expect(raw.stdout).toContain(privateValue)

        const redacted = yield* mongolgpt.spawn(["export", input.info.id, "--sanitize"])
        mongolgpt.expectExit(redacted, 0, "sanitized export")
        expect(redacted.stderr).toContain("Сешн экспортолж байна")
        const result = JSON.parse(redacted.stdout)
        validate(result)
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].parts).toHaveLength(2)
        expect(result.messages[0].info.error.data.statusCode).toBe(429)
        expect(result.messages[0].parts[0].error.data.isRetryable).toBe(false)
        expect(result.messages[0].parts[1].state.error).toContain("[redacted:tool-error:")

        const after = yield* mongolgpt.spawn(["export", input.info.id])
        mongolgpt.expectExit(after, 0, "raw export after sanitizing")
        expect(after.stdout).toBe(raw.stdout)
      }),
    60_000,
  )
})
