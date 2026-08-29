import { describe, expect, test } from "bun:test"
import { AuthError, PlanUsageLimitError, QuotaServiceUnavailableError } from "./error"
import { gatewayErrorResponse } from "./error-response"

async function body(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  return response.json()
}

describe("gateway error responses", () => {
  test("returns a retryable 503 when the quota service is unavailable", async () => {
    const response = gatewayErrorResponse(
      new QuotaServiceUnavailableError("Хязгаарын үйлчилгээ түр хариу өгөхгүй байна.", 60),
      "Дотоод алдаа",
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("60")
    expect(await body(response)).toEqual({
      type: "error",
      error: {
        type: "QuotaServiceUnavailableError",
        message: "Хязгаарын үйлчилгээ түр хариу өгөхгүй байна.",
      },
      metadata: {},
    })
  })

  test("keeps real quota exhaustion separate as 429", async () => {
    const response = gatewayErrorResponse(new PlanUsageLimitError("Багцын хязгаарт хүрлээ.", 120), "Дотоод алдаа")

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("120")
    expect((await body(response)).error.type).toBe("PlanUsageLimitError")
  })

  test("keeps authentication errors as JSON and hides unknown failure details", async () => {
    const auth = gatewayErrorResponse(new AuthError("Нэвтрэх шаардлагатай."), "Дотоод алдаа")
    expect(auth.status).toBe(401)
    expect((await body(auth)).error.message).toBe("Нэвтрэх шаардлагатай.")

    const internal = gatewayErrorResponse(new Error("secret provider detail"), "Ерөнхий алдаа")
    expect(internal.status).toBe(500)
    expect(await body(internal)).toEqual({ type: "error", error: { type: "error", message: "Ерөнхий алдаа" } })
  })
})
