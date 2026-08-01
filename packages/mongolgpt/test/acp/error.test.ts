import { describe, expect, test } from "bun:test"
import { RequestError } from "@agentclientprotocol/sdk"
import * as ACPError from "../../src/acp/error"

describe("acp.error", () => {
  test("maps validation failures to invalid params", () => {
    const cases: Array<{ error: ACPError.Error; message: string; data: unknown }> = [
      {
        error: new ACPError.SessionNotFoundError({ sessionId: "ses_missing" }),
        message: "Сесс олдсонгүй: ses_missing",
        data: { sessionId: "ses_missing" },
      },
      {
        error: new ACPError.InvalidConfigOptionError({ configId: "temperature" }),
        message: "Тохиргооны сонголт танигдсангүй: temperature",
        data: { configId: "temperature" },
      },
      {
        error: new ACPError.InvalidModelError({ providerId: "anthropic", modelId: "claude-missing" }),
        message: "Загвар олдсонгүй: claude-missing",
        data: { providerId: "anthropic", modelId: "claude-missing" },
      },
      {
        error: new ACPError.InvalidEffortError({ effort: "extreme" }),
        message: "Чармайлтын түвшин танигдсангүй: extreme",
        data: { effort: "extreme" },
      },
      {
        error: new ACPError.InvalidModeError({ mode: "turbo" }),
        message: "Горим танигдсангүй: turbo",
        data: { mode: "turbo" },
      },
      {
        error: new ACPError.UnknownAuthMethodError({ methodId: "legacy" }),
        message: "Нэвтрэх арга танигдсангүй: legacy",
        data: { methodId: "legacy" },
      },
    ]

    for (const item of cases) {
      expect(ACPError.toRequestError(item.error)).toMatchObject({
        code: -32602,
        message: item.message,
        data: item.data,
      })
    }
  })

  test("includes safe validation details", () => {
    expect(ACPError.toRequestError(new ACPError.SessionNotFoundError({ sessionId: "ses_123" }))).toMatchObject({
      code: -32602,
      message: "Сесс олдсонгүй: ses_123",
      data: { sessionId: "ses_123" },
    })
    expect(ACPError.toRequestError(new ACPError.InvalidModelError({ modelId: "gpt-missing" }))).toMatchObject({
      code: -32602,
      message: "Загвар олдсонгүй: gpt-missing",
      data: { modelId: "gpt-missing" },
    })
  })

  test("maps auth required to the SDK auth error", () => {
    const requestError = ACPError.toRequestError(new ACPError.AuthRequiredError({ providerId: "anthropic" }))

    expect(requestError).toBeInstanceOf(RequestError)
    expect(requestError.code).toBe(-32000)
    expect(requestError.message).toBe("Үйлчилгээ үзүүлэгчид нэвтрэх шаардлагатай")
    expect(requestError.data).toEqual({ providerId: "anthropic" })
  })

  test("maps unsupported operations to method not found", () => {
    const requestError = ACPError.toRequestError(new ACPError.UnsupportedOperationError({ method: "session/new" }))

    expect(requestError.code).toBe(-32601)
    expect(requestError.message).toBe("Үйлдэл олдсонгүй: session/new")
    expect(requestError.data).toEqual({ method: "session/new" })
  })

  test("maps service failures to safe internal errors", () => {
    const requestError = ACPError.toRequestError(
      new ACPError.ServiceFailureError({
        service: "provider",
        safeMessage: "Үйлчилгээ үзүүлэгчийн хүсэлт амжилтгүй боллоо",
      }),
    )

    expect(requestError.code).toBe(-32603)
    expect(requestError.message).toBe("Дотоод алдаа: Үйлчилгээ үзүүлэгчийн хүсэлт амжилтгүй боллоо")
    expect(requestError.data).toEqual({ service: "provider" })
  })

  test("wraps unknown defects without leaking raw details", () => {
    const requestError = ACPError.toRequestError(
      ACPError.fromUnknownDefect(new Error("stack has sk-ant-secret and oauth refresh token")),
    )
    const serialized = JSON.stringify(requestError.toErrorResponse())

    expect(requestError.code).toBe(-32603)
    expect(requestError.message).toBe("Дотоод алдаа: Дотоод үйлчилгээний алдаа гарлаа")
    expect(serialized).not.toContain("sk-ant-secret")
    expect(serialized).not.toContain("oauth refresh token")
    expect(serialized).not.toContain("stack")
  })
})
