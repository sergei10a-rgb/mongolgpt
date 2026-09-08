import { cleanupCanaryResourceReceipt, createCanaryName, type CanaryRequest } from "./canary-resources"
import { readCanaryJson } from "./canary-probe"

export async function cleanupEmptyCanary(input: {
  accountID: string
  token: string
  runID: string
  attempt: string
  databaseID: string
  containerApplicationID: string
  request?: CanaryRequest
}) {
  const name = createCanaryName(input.runID, input.attempt)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.databaseID))
    throw new Error("Invalid canary database ID")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.containerApplicationID))
    throw new Error("Invalid canary application ID")
  const request = input.request ?? fetch
  return cleanupCanaryResourceReceipt({
    accountID: input.accountID,
    token: input.token,
    receipt: {
      name,
      databaseID: input.databaseID,
      containerApplicationID: input.containerApplicationID,
      r2BucketCreated: true,
      workerDeployed: true,
    },
    request,
    // Recovery is allowed only before any VM or Durable Object instance exists.
    // The resource helper then verifies exact Worker/D1/R2/namespace ownership;
    // R2 deletion remains non-forced and therefore requires an empty bucket.
    purge: async () => {
      const response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${input.accountID}/containers/dash/applications/${input.containerApplicationID}/instances?per_page=1`,
        {
          headers: { authorization: `Bearer ${input.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      )
      const page = await readCanaryJson<{
        success?: boolean
        result?: { instances?: unknown[]; durable_objects?: unknown[] }
        result_info?: { next_page_token?: string }
      }>(response)
      if (
        page.success !== true ||
        !Array.isArray(page.result?.instances) ||
        page.result.instances.length !== 0 ||
        (page.result.durable_objects !== undefined &&
          (!Array.isArray(page.result.durable_objects) || page.result.durable_objects.length !== 0)) ||
        page.result_info?.next_page_token
      )
        throw new Error("Canary has instances or an unverified instance listing; refusing empty recovery")
    },
  })
}

if (import.meta.main) {
  try {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.CANARY_CLEANUP_CONFIRMATION !== "CLEAN EMPTY CANARY"
    )
      throw new Error("Empty recovery requires the confirmed owner workflow")
    const result = await cleanupEmptyCanary({
      accountID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      token: process.env.CLOUDFLARE_API_TOKEN ?? "",
      runID: process.env.CANARY_RUN_ID ?? "",
      attempt: process.env.CANARY_ATTEMPT ?? "",
      databaseID: process.env.CANARY_DATABASE_ID ?? "",
      containerApplicationID: process.env.CANARY_APPLICATION_ID ?? "",
    })
    console.log(JSON.stringify(result))
    process.exitCode = result.failures.length === 0 && result.manualCleanup.length === 0 ? 0 : 1
  } catch {
    console.error("Empty canary recovery failed; no credentials or private response content are printed")
    process.exitCode = 1
  }
}
