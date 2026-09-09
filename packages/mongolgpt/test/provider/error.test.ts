import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderV2 } from "@mongolgpt/core/provider"
import { ProviderError } from "@/provider/error"

const providerID = ProviderV2.ID.make("test")

type APICallErrorOptions = ConstructorParameters<typeof APICallError>[0]

const apiError = (input: Partial<APICallErrorOptions>) => {
  const options: APICallErrorOptions = {
    message: "Request failed",
    url: "https://example.com",
    requestBodyValues: {},
    responseHeaders: { "content-type": "application/json" },
    isRetryable: false,
    ...input,
  }
  return new APICallError(options)
}

describe("provider error localization", () => {
  test.each(["https://opencode.ai/zen/v1/chat/completions", "https://opencode.ai/zen/v1/messages"])(
    "stops exhausted public free quota at %s without a plan upsell",
    (url) => {
      const error = apiError({
        url,
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { "retry-after": "41024" },
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      })
      const result = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("mongolgpt"), error })
      expect(result).toMatchObject({
        type: "api_error",
        statusCode: 429,
        isRetryable: false,
        message:
          "Үнэгүй загварын үйлчилгээ үзүүлэгчийн хэрэглээний хязгаарт хүрлээ. Хязгаар шинэчлэгдсэний дараа дахин оролдоно уу. Энэ хүсэлтийг автоматаар дахин илгээхгүй.",
        responseHeaders: { "retry-after": "41024" },
        responseBody: error.responseBody,
        metadata: { url },
      })
    },
  )

  test.each([
    "https://dev.mgpt.mn/gateway/v1/chat/completions",
    "https://opencode.ai.example.com/zen/v1/chat/completions",
    "https://opencode.ai/other/v1/chat/completions",
  ])("preserves quota policy for other APIs at %s", (url) => {
    expect(
      ProviderError.parseAPICallError({
        providerID,
        error: apiError({
          url,
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({ error: { type: "FreeUsageLimitError" } }),
        }),
      }),
    ).toMatchObject({ message: "Request failed", isRetryable: true })
  })

  test.each([
    { statusCode: 429, responseBody: '{"error":{"type":"RateLimitError"}}' },
    { statusCode: 503, responseBody: '{"error":{"type":"FreeUsageLimitError"}}' },
    { statusCode: 429, responseBody: '{"error":{"message":"mentions FreeUsageLimitError"}}' },
    { statusCode: 429, responseBody: "invalid JSON FreeUsageLimitError" },
  ])("preserves transient public API errors: %j", (input) => {
    expect(
      ProviderError.parseAPICallError({
        providerID,
        error: apiError({ url: "https://opencode.ai/zen/v1/chat/completions", isRetryable: true, ...input }),
      }),
    ).toMatchObject({ message: "Request failed", isRetryable: true })
  })

  test("localizes the provider header timeout fallback", () => {
    expect(new ProviderError.HeaderTimeoutError(50).message).toBe(
      "Үйлчилгээ үзүүлэгчийн хариуны толгой хэсгийг 50 миллисекундийн дотор хүлээн авч чадсангүй.",
    )
  })

  test("localizes provider fallback stream messages", () => {
    expect(ProviderError.parseStreamError({ type: "error", error: { code: "context_length_exceeded" } })?.message).toBe(
      "Оруулсан мэдээлэл энэ загварын контекстийн багтаамжаас хэтэрлээ.",
    )
    expect(ProviderError.parseStreamError({ type: "error", error: { code: "insufficient_quota" } })?.message).toBe(
      "Хэрэглээний хязгаар дууслаа. Багц болон төлбөрийн мэдээллээ шалгана уу.",
    )
    expect(ProviderError.parseStreamError({ type: "error", error: { code: "invalid_prompt" } })?.message).toBe(
      "Оруулсан заавар буруу байна.",
    )
    expect(ProviderError.parseStreamError({ type: "error", error: { code: "server_error" } })?.message).toBe(
      "Серверийн алдаа гарлаа.",
    )
  })

  test("localizes gateway fallback messages and preserves provider details", () => {
    expect(
      ProviderError.parseAPICallError({
        providerID,
        error: apiError({
          message: "Unauthorized",
          statusCode: 401,
          responseBody: "<!doctype html><html>gateway</html>",
        }),
      }).message,
    ).toBe(
      "Нэвтрэх зөвшөөрөлгүй: хүсэлтийг API гарц эсвэл зуучлагч сервер хаасан байна. Нэвтрэх баталгаажуулалтын мэдээлэл байхгүй эсвэл хугацаа нь дууссан байж болзошгүй. Дахин нэвтрэхийн тулд `mongolgpt auth login <your provider URL>` командыг ажиллуулна уу.",
    )
    expect(
      ProviderError.parseAPICallError({
        providerID,
        error: apiError({
          message: "Forbidden",
          statusCode: 403,
          responseBody: "<!doctype html><html>gateway</html>",
        }),
      }).message,
    ).toBe(
      "Хандах эрхгүй: хүсэлтийг API гарц эсвэл зуучлагч сервер хаасан байна. Энэ нөөцөд хандах эрхгүй байж болзошгүй тул бүртгэл болон үйлчилгээ үзүүлэгчийн тохиргоогоо шалгана уу.",
    )
    expect(
      ProviderError.parseAPICallError({
        providerID,
        error: apiError({ message: "", statusCode: 418 }),
      }).message,
    ).toBe("I'm a Teapot")
    expect(
      ProviderError.parseAPICallError({
        providerID,
        error: apiError({ message: "Гуравдагч талын өөрчлөгдөх ёсгүй мэдэгдэл" }),
      }).message,
    ).toBe("Гуравдагч талын өөрчлөгдөх ёсгүй мэдэгдэл")
  })
})
