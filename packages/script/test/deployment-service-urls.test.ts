import { describe, expect, test } from "bun:test"
import { deploymentServiceUrlOutputs, serializeGitHubOutputs } from "../src/deployment-service-urls"

describe("deployment service URL outputs", () => {
  test("serializes dev URLs for GitHub Actions without recomputing hosts in YAML", () => {
    const outputs = deploymentServiceUrlOutputs("mgpt.mn", "dev")
    expect(outputs).toEqual({
      channel: "dev",
      app_url: "https://app.dev.mgpt.mn",
      public_url: "https://dev.mgpt.mn",
      runtime_url: "https://runtime.dev.mgpt.mn",
      payment_url: "https://pay.dev.mgpt.mn",
    })
    expect(serializeGitHubOutputs(outputs)).toBe(
      [
        "channel=dev",
        "app_url=https://app.dev.mgpt.mn",
        "public_url=https://dev.mgpt.mn",
        "runtime_url=https://runtime.dev.mgpt.mn",
        "payment_url=https://pay.dev.mgpt.mn",
      ].join("\n"),
    )
  })

  test("does not add a production stage label to production hosts", () => {
    expect(deploymentServiceUrlOutputs("mgpt.mn", "production")).toEqual({
      channel: "prod",
      app_url: "https://app.mgpt.mn",
      public_url: "https://mgpt.mn",
      runtime_url: "https://runtime.mgpt.mn",
      payment_url: "https://pay.mgpt.mn",
    })
  })

  test("rejects malformed workflow inputs", () => {
    expect(() => deploymentServiceUrlOutputs("MGPT.MN", "dev")).toThrow()
    expect(() => deploymentServiceUrlOutputs("mgpt.mn", "DEV")).toThrow()
  })
})
