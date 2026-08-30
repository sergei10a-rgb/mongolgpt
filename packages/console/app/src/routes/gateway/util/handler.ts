import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, gt, gte, isNull, lte, sql } from "@mongolgpt/console-core/drizzle/index.js"
import { KeyTable } from "@mongolgpt/console-core/schema/key.sql.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import {
  BillingTable,
  PlanSubscriptionTable,
  SubscriptionTable,
  UsageTable,
} from "@mongolgpt/console-core/schema/billing.sql.js"
import { centsToMicroCents } from "@mongolgpt/console-core/util/price.js"
import { getWeekBounds } from "@mongolgpt/console-core/util/date.js"
import { Identifier } from "@mongolgpt/console-core/identifier.js"
import { recordPlanUsageWithDb } from "@mongolgpt/console-core/plan-usage.js"
import { recordEstimatedModelCostWithDb } from "@mongolgpt/console-core/finance-ledger.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { GatewayCatalog } from "@mongolgpt/console-core/model.js"
import { isProviderAllowedForStage } from "@mongolgpt/console-core/model-config.js"
import { Subscription } from "@mongolgpt/console-core/subscription.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { ModelTable } from "@mongolgpt/console-core/schema/model.sql.js"
import { ProviderTable } from "@mongolgpt/console-core/schema/provider.sql.js"
import { ProviderCredentials } from "@mongolgpt/console-core/provider-credentials.js"
import { hostedFreeWorkspaceIDs } from "~/lib/hosted-env"
import { logger } from "./logger"
import {
  AuthError,
  CreditsError,
  MonthlyLimitError,
  UserLimitError,
  ModelError,
  RateLimitError,
  FreeUsageLimitError,
  PlanUsageLimitError,
  QuotaServiceUnavailableError,
} from "./error"
import { gatewayErrorResponse } from "./error-response"
import {
  buildCostChunk,
  createBodyConverter,
  createStreamPartConverter,
  createResponseConverter,
  UsageInfo,
} from "./provider/provider"
import { anthropicHelper } from "./provider/anthropic"
import { googleHelper } from "./provider/google"
import { openaiHelper } from "./provider/openai"
import { oaCompatHelper } from "./provider/openai-compatible"
import { clientIpFromRequest, createRateLimiter as createIpRateLimiter } from "./ipRateLimiter"
import { createRateLimiter as createKeyRateLimiter } from "./keyRateLimiter"
import { createTrialLimiter } from "./trialLimiter"
import { createStickyTracker } from "./stickyProviderTracker"
import { Resource } from "@mongolgpt/console-resource"
import { i18n, type Key } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { config } from "~/config"
import { createModelTpmLimiter } from "./modelTpmLimiter"
import { createModelTpsLimiter } from "./modelTpsLimiter"
import { createProviderBudgetTracker } from "./providerBudgetTracker"
import { enqueueBatchedUsage, HOT_WORKSPACES } from "./usageBatcher"
import { resolveGatewayWorkspace, verifyGatewayAccount } from "~/lib/cli-auth"
import { authenticatedRateLimitIdentity, sanitizeProviderRequestHeaders } from "./request-security"
import { freeAutoReservationUpperBound, reserveFreeAutoQuota } from "./free-auto-quota"
import { planQuotaReservationBounds, reservePlanQuota } from "./plan-quota"
import {
  acquireProviderFailoverRoute,
  fetchWith429Retry,
  partitionProviderFailoverRoutes,
  runProviderAttempt,
  shouldFailoverProviderStatus,
} from "./provider-retry"
import { providerCircuit, providerCircuitKey } from "./provider-circuit"
import {
  resolveImmediateBillingSource,
  selectByokProviderRoute,
  selectServerProviderRoutes,
  trackAndSettleMeasuredUsage,
  type BillingSource,
} from "./request-lifecycle"

type GatewayCatalogData = Awaited<ReturnType<typeof GatewayCatalog.list>>
type RetryOptions = {
  excludeProviders: string[]
  retryCount: number
}
type AuthCredential = { type: "key"; value: string } | { type: "account"; accountID: string; workspaceID: string }

function resolve(text: string, params?: Record<string, string | number>) {
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (raw, key) => {
    const value = params[key]
    if (value === undefined || value === null) return raw
    return String(value)
  })
}

function contentByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function locationCode(value: string | undefined) {
  const normalized = value?.trim().toUpperCase()
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined
}

function consolePath(path: string) {
  const base = config.baseUrl.replace(/\/+$/, "")
  return `${base}/${path.replace(/^\/+/, "")}`
}

function configuredWorkspaceIDs(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function formatRetryTime(seconds: number, locale: string) {
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return locale === "mn" ? `${days} өдөр` : `${days} day${days === 1 ? "" : "s"}`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)
  if (hours >= 1)
    return locale === "mn"
      ? `${hours} цаг ${minutes} минут`
      : `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`
  return locale === "mn" ? `${minutes} минут` : `${minutes} minute${minutes === 1 ? "" : "s"}`
}

export async function handler(
  input: APIEvent,
  opts: {
    format: GatewayCatalog.Format
    modelList: "full"
    parseApiKey: (headers: Headers) => string | undefined
    parseModel: (url: string, body: any) => string
    parseVariant: (url: string, body: any) => string | undefined
    parseIsStream: (url: string, body: any) => boolean
  },
) {
  type AuthInfo = Awaited<ReturnType<typeof authenticate>>
  type ModelInfo = Awaited<ReturnType<typeof validateModel>>
  type ProviderInfo = Awaited<ReturnType<typeof selectProvider>>
  type ProviderRequestResult = { providerInfo: ProviderInfo; res: Response; startTimestamp: number }
  type CostInfo = ReturnType<typeof calculateCost>
  type Limits = Awaited<ReturnType<typeof Subscription.getLimits>>

  const MAX_FAILOVER_RETRIES = 3
  const MINUTE_IN_SECONDS = 60
  const locale = localeFromRequest(input.request)
  const dict = i18n(locale)
  const t = (key: Key, params?: Record<string, string | number>) => resolve(dict[key], params)
  const freeWorkspaceIDs = configuredWorkspaceIDs(hostedFreeWorkspaceIDs)
  type PlanQuotaReservation = Extract<Awaited<ReturnType<typeof reservePlanQuota>>, { allowed: true }>["reservation"]
  const quota = {
    freeAuto: undefined as Awaited<ReturnType<typeof reserveFreeAutoQuota>>,
    plan: undefined as PlanQuotaReservation | undefined,
  }

  try {
    const url = input.request.url
    const body = await input.request.json()
    const model = opts.parseModel(url, body)
    const variant = opts.parseVariant(url, body)
    const isStream = opts.parseIsStream(url, body)
    const ip = clientIpFromRequest(input.request)
    const rawGatewayApiKey = opts.parseApiKey(input.request.headers)
    const gatewayApiKey = rawGatewayApiKey === "public" ? undefined : rawGatewayApiKey
    const sessionId = input.request.headers.get("x-mongolgpt-session") ?? ""
    const requestId = input.request.headers.get("x-mongolgpt-request") ?? ""
    const ocClient = input.request.headers.get("x-mongolgpt-client") ?? ""
    const projectId = input.request.headers.get("x-mongolgpt-project") ?? ""
    const userAgent = input.request.headers.get("user-agent") ?? ""
    const limits = await Subscription.getLimits()
    logger.metric({
      is_stream: isStream,
      session: sessionId,
      request: requestId,
      client: ocClient,
      user_agent: userAgent,
      "model.variant": variant,
      "model.tier": opts.modelList,
    })
    const catalog = GatewayCatalog.list(opts.modelList)
    const modelInfo = validateModel(catalog, model)
    const authInfo = await authenticate(modelInfo, gatewayApiKey)
    const trialLimiter = await createTrialLimiter(modelInfo.trialProvider, ip, limits.free)
    const trialProviders = await trialLimiter?.check()
    const rateLimiter = modelInfo.allowAnonymous
      ? await createIpRateLimiter(modelInfo.id, modelInfo.rateLimit, input.request, limits.free)
      : createKeyRateLimiter(
          modelInfo.id,
          modelInfo.rateLimit,
          authenticatedRateLimitIdentity(
            authInfo ? { workspaceID: authInfo.workspaceID, userID: authInfo.user.id } : undefined,
            gatewayApiKey,
          ),
          input.request,
        )
    await rateLimiter?.check()
    const stickyId = sessionId ? sessionId : (authInfo?.workspaceID ?? ip)
    const stickyTracker = createStickyTracker(modelInfo.id, modelInfo.stickyProvider, stickyId)
    const stickyProvider = await stickyTracker?.get()
    const billingSource = validateBilling(authInfo, modelInfo, limits)
    quota.freeAuto = await reserveFreeAutoWeeklyUsage(authInfo, modelInfo)
    quota.plan = await reservePaidPlanUsage(billingSource, authInfo, modelInfo, limits)
    logger.metric({ source: billingSource })
    const modelTpmLimiter = createModelTpmLimiter(modelInfo.providers)
    const modelTpmLimits = await modelTpmLimiter?.check()
    const modelTpsLimiter = createModelTpsLimiter(modelInfo.providers)
    const modelTpsLimits = await modelTpsLimiter?.check()
    const providerBudgetTracker = createProviderBudgetTracker(
      modelInfo.providers.map((provider) => ({ ...catalog.providers[provider.id], ...provider })),
    )
    const providerBudgetUsage = await providerBudgetTracker?.check()

    const retriableRequest = async (
      retry: RetryOptions = { excludeProviders: [], retryCount: 0 },
    ): Promise<ProviderRequestResult> => {
      const providerInfo = selectProvider(
        model,
        catalog,
        authInfo,
        modelInfo,
        stickyId,
        trialProviders,
        retry,
        stickyProvider,
        modelTpmLimits,
        modelTpsLimits,
        providerBudgetUsage,
      )
      validateModelSettings(billingSource, authInfo)
      logger.metric({
        provider: providerInfo.id,
        "provider.model": providerInfo.model,
      })
      await updateProviderKey(authInfo, modelInfo, providerInfo)

      const startTimestamp = Date.now()
      const reqUrl = providerInfo.modifyUrl(providerInfo.api, isStream)
      const reqBody = JSON.stringify(
        providerInfo.modifyBody({
          ...createBodyConverter(opts.format, providerInfo.format)(body),
          model: providerInfo.model,
          ...(() => {
            const replacer = (obj: Record<string, any>): Record<string, any> =>
              Object.fromEntries(
                Object.entries(obj).flatMap(([k, v]) => {
                  if (Array.isArray(v)) return [[k, v]]
                  if (typeof v === "object") return [[k, replacer(v)]]
                  if (typeof v === "string") {
                    if (v === "$workspace") return authInfo?.workspaceID ? [[k, authInfo?.workspaceID]] : []
                    if (v === "$user") return stickyId ? [[k, stickyId]] : []
                    if (v.startsWith("$header.")) {
                      const headerValue = input.request.headers.get(v.slice(8))
                      return headerValue ? [[k, headerValue]] : []
                    }
                  }
                  return [[k, v]]
                }),
              )
            return replacer(providerInfo.payloadModifier ?? {})
          })(),
        }),
      )
      const requestLength = contentByteLength(reqBody)
      logger.metric({
        request_length: requestLength,
        request_retry: retry.retryCount,
      })
      return runProviderAttempt({
        retry,
        policy: {
          maxRetries: MAX_FAILOVER_RETRIES,
          stickyProvider: modelInfo.stickyProvider,
          fallbackProvider: modelInfo.fallbackProviders,
          currentProvider: providerInfo.id,
        },
        request: () =>
          fetchWith429Retry(reqUrl, {
            method: "POST",
            headers: (() => {
              const headers = sanitizeProviderRequestHeaders(input.request.headers)
              providerInfo.modifyHeaders(headers, providerInfo.apiKey, stickyId)
              Object.entries(providerInfo.headerModifier ?? {}).forEach(([k, v]) => {
                if (v === "$ip") return headers.set(k, ip)
                if (v === "$caller") return headers.set(k, stickyId)
                if (v === "$session") return headers.set(k, sessionId)
                if (v === "$model") return headers.set(k, model)
                if (v === "$request") return headers.set(k, requestId)
                if (v === "$project") return headers.set(k, projectId)
                if (v === "$workspace" && authInfo?.workspaceID) return headers.set(k, authInfo.workspaceID)
                headers.set(k, v)
              })
              headers.delete("host")
              headers.delete("content-length")
              headers.delete("x-mongolgpt-request")
              headers.delete("x-mongolgpt-session")
              headers.delete("x-mongolgpt-project")
              headers.delete("x-mongolgpt-client")
              return headers
            })(),
            body: reqBody,
          }),
        onNetworkError() {
          providerCircuit.record(providerInfo.circuitPermit, "transient-error")
          logger.metric({ "llm.error.type": "network" })
        },
        onResponse(res) {
          if (providerInfo.id.startsWith("console.")) {
            const resEndpointId = res.headers.get("x-mongolgpt-endpoint-id")
            const resEndpointModelId = res.headers.get("x-mongolgpt-upstream-model-id")
            if (resEndpointId && resEndpointModelId)
              logger.metric({
                provider: resEndpointId,
                "provider.model": resEndpointModelId,
              })
          }

          if (res.status !== 200) {
            logger.metric({
              "llm.error.code": res.status,
            })
          }

          providerCircuit.record(
            providerInfo.circuitPermit,
            res.status === 200
              ? "success"
              : shouldFailoverProviderStatus(res.status)
                ? "transient-error"
                : "permanent-error",
          )
        },
        failover: retriableRequest,
        complete: (res) => ({ providerInfo, res, startTimestamp }),
      })
    }

    const { providerInfo, res, startTimestamp } = await retriableRequest()

    // Store sticky provider
    if (res.status === 200) await stickyTracker?.set(providerInfo.id)

    // Temporarily change 404 to 400 status code b/c solid start automatically override 404 response
    const resStatus = res.status === 404 ? 400 : res.status

    // Scrub response headers
    const resHeaders = new Headers()
    const keepHeaders = ["content-type", "cache-control"]
    for (const [k, v] of res.headers.entries()) {
      if (keepHeaders.includes(k.toLowerCase())) {
        resHeaders.set(k, v)
      }
    }
    logger.metric({ response_status: res.status })

    // Handle non-streaming response
    if (!isStream || [400, 404, 429].includes(res.status)) {
      const json = await res.json()
      await rateLimiter?.track()
      const usage = providerInfo.extractUsage(json)
      if (usage) {
        const usageInfo = providerInfo.normalizeUsage(usage)
        const costInfo = calculateCost(modelInfo, usageInfo)
        await trialLimiter?.track(usageInfo)
        await modelTpmLimiter?.track(providerInfo.id, providerInfo.model, usageInfo)
        await providerBudgetTracker?.track(providerInfo.id, costInfo.totalCostInCent)
        const actual = {
          costInMicroCents: centsToMicroCents(costInfo.totalCostInCent),
          tokens: usageTokenTotal(usageInfo),
        }
        await trackAndSettleMeasuredUsage({
          actual,
          track: () =>
            trackUsage(sessionId, billingSource, authInfo, modelInfo, providerInfo, usageInfo, costInfo, limits),
          settle: settleRequestQuota,
        })
        json.cost = calculateOccurredCost(billingSource, costInfo)
      }
      if (json.error?.message) {
        json.error.message = t("gateway.api.error.providerFailure", {
          provider: providerInfo.displayName ? ` (${providerInfo.displayName})` : "",
          message: json.error.message,
        })
      }

      const responseConverter = createResponseConverter(providerInfo.format, opts.format)
      const body = JSON.stringify(responseConverter(json))
      const responseLength = contentByteLength(body)
      logger.metric({ response_length: responseLength })
      if (!usage && res.status >= 400) await releaseRequestQuota()
      else await settleRequestQuota()
      return new Response(body, {
        status: resStatus,
        statusText: res.statusText,
        headers: resHeaders,
      })
    }

    // Handle streaming response
    const streamConverter = createStreamPartConverter(providerInfo.format, opts.format)
    const usageParser = providerInfo.createUsageParser()
    const binaryDecoder = providerInfo.createBinaryStreamDecoder()
    const stream = new ReadableStream({
      start(c) {
        const reader = res.body?.getReader()
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()

        let buffer = ""
        let responseLength = 0
        let timestampFirstByte = 0

        function pump(): Promise<void> {
          return (
            reader?.read().then(async ({ done, value: rawValue }) => {
              if (done) {
                const timestampLastByte = Date.now()
                logger.metric({
                  response_length: responseLength,
                  "timestamp.last_byte": timestampLastByte,
                })
                await rateLimiter?.track()
                const usage = usageParser.retrieve()
                if (usage) {
                  const usageInfo = providerInfo.normalizeUsage(usage)
                  const costInfo = calculateCost(modelInfo, usageInfo)
                  await trialLimiter?.track(usageInfo)
                  await modelTpmLimiter?.track(providerInfo.id, providerInfo.model, usageInfo)
                  await modelTpsLimiter?.track(
                    providerInfo.id,
                    providerInfo.model,
                    providerInfo.tpsGoal,
                    timestampFirstByte,
                    timestampLastByte,
                    usageInfo,
                  )
                  await providerBudgetTracker?.track(providerInfo.id, costInfo.totalCostInCent)
                  const actual = {
                    costInMicroCents: centsToMicroCents(costInfo.totalCostInCent),
                    tokens: usageTokenTotal(usageInfo),
                  }
                  await trackAndSettleMeasuredUsage({
                    actual,
                    track: () =>
                      trackUsage(
                        sessionId,
                        billingSource,
                        authInfo,
                        modelInfo,
                        providerInfo,
                        usageInfo,
                        costInfo,
                        limits,
                      ),
                    settle: settleRequestQuota,
                  })
                  const cost = calculateOccurredCost(billingSource, costInfo)
                  c.enqueue(encoder.encode(buildCostChunk(opts.format, cost)))
                }
                await settleRequestQuota()
                c.close()
                return
              }

              if (responseLength === 0) {
                timestampFirstByte = Date.now()
                logger.metric({
                  time_to_first_byte: timestampFirstByte - startTimestamp,
                  "timestamp.first_byte": timestampFirstByte,
                })
              }

              const value = binaryDecoder ? binaryDecoder(rawValue) : rawValue
              if (!value) return

              responseLength += value.length
              buffer += decoder.decode(value, { stream: true })

              const parts = buffer.split(/\r\n\r\n|\n\n|\r\r/)
              buffer = parts.pop() ?? ""

              for (let part of parts) {
                part = part.trim()
                usageParser.parse(part)

                if (providerInfo.format !== opts.format) {
                  part = streamConverter(part)
                  c.enqueue(encoder.encode(part + "\n\n"))
                }
              }

              if (providerInfo.format === opts.format) {
                c.enqueue(value)
              }

              return pump()
            }) || Promise.resolve()
          )
        }

        return pump().catch(async (error) => {
          // Partial streams have no trustworthy usage total; retain the reservation to prevent cancel-after-output bypass.
          await settleRequestQuota()
          c.error(error)
        })
      },
      async cancel() {
        // A client can cancel after receiving output, so an unmeasured cancellation must remain conservatively reserved.
        await settleRequestQuota()
      },
    })
    return new Response(stream, {
      status: resStatus,
      statusText: res.statusText,
      headers: resHeaders,
    })
  } catch (error) {
    // Measured usage is already settled idempotently; otherwise retain the reservation for an indeterminate provider call.
    await settleRequestQuota()
    logger.metric({
      "error.type": error instanceof Error ? error.constructor.name : "UnknownError",
    })

    return gatewayErrorResponse(error, t("gateway.api.error.internalServer"))
  }

  function validateModel(catalog: GatewayCatalogData, reqModel: string) {
    if (!(reqModel in catalog.models))
      throw new ModelError(t("gateway.api.error.modelNotSupported", { model: reqModel }))

    const modelId = reqModel
    const modelData = Array.isArray(catalog.models[modelId])
      ? catalog.models[modelId].find((model) => opts.format === model.formatFilter)
      : catalog.models[modelId]

    if (!modelData)
      throw new ModelError(
        t("gateway.api.error.modelFormatNotSupported", {
          model: reqModel,
          format: opts.format,
        }),
      )

    if (modelData.trialEnded)
      throw new ModelError(
        `${t("gateway.api.error.trialEnded", {
          model: modelData.name,
          link: consolePath("/pricing"),
        })}`,
      )

    logger.metric({ model: modelId })

    return { id: modelId, ...modelData }
  }

  function selectProvider(
    reqModel: string,
    catalog: GatewayCatalogData,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    stickyId: string,
    trialProviders: string[] | undefined,
    retry: RetryOptions,
    stickyProviderId: string | undefined,
    modelTpmLimits: Record<string, number> | undefined,
    modelTpsLimits: Record<string, { qualify: number; unqualify: number }> | undefined,
    providerBudgetUsage: Record<string, number> | undefined,
  ) {
    const selected = (() => {
      // Byok is top priority b/c if user set their own API key, we should use it
      // instead of using the sticky provider for the same session
      if (authInfo?.provider?.credentials && modelInfo.byokProvider) {
        const provider = selectByokProviderRoute({
          hasCredentials: true,
          byokProvider: modelInfo.byokProvider,
          providers: modelInfo.providers,
          catalogProviders: catalog.providers,
        })
        if (!provider) return undefined
        const circuitPermit = providerCircuit.acquire(
          providerCircuitKey(provider.id, { workspaceID: authInfo.workspaceID, modelID: reqModel }),
        )
        return circuitPermit ? { provider, circuitPermit } : undefined
      }

      // Prioritize trial providers
      let allProviders = selectServerProviderRoutes(modelInfo.providers, catalog.providers)
        .filter((provider) => isProviderAllowedForStage(catalog.providers[provider.id], Resource.App.stage))
      if (trialProviders) {
        allProviders = allProviders.map((provider) => ({
          ...provider,
          priority: trialProviders.includes(provider.id) ? 0 : provider.priority,
        }))
      }

      const routes = partitionProviderFailoverRoutes(allProviders, modelInfo.fallbackProviders)
      const acquire = (provider: (typeof allProviders)[number]) =>
        providerCircuit.acquire(providerCircuitKey(provider.id))

      if (retry.retryCount !== MAX_FAILOVER_RETRIES) {
        let topPriority = Infinity
        const providers = routes.primaryProviders
          .filter((provider) => provider.weight !== 0)
          .filter((provider) => !retry.excludeProviders.includes(provider.id))
          .filter((provider) => {
            if (provider.budgetMode !== "fill") return true
            const budget = catalog.providers[provider.id]?.budget
            if (budget === undefined) return false
            return (providerBudgetUsage?.[provider.id] ?? 0) < centsToMicroCents(budget * 100)
          })
          .filter((provider) => {
            if (!provider.tpmLimit) return true
            const usage = modelTpmLimits?.[`${provider.id}/${provider.model}`] ?? 0
            return usage < provider.tpmLimit * 1_000_000
          })
          .filter((provider) => {
            if (!provider.tpsGoal) return true
            const tps = modelTpsLimits?.[`${provider.id}/${provider.model}/${provider.tpsGoal}`] ?? {
              qualify: 0,
              unqualify: 0,
            }
            const isLowTps = tps.qualify + tps.unqualify > 10 && tps.qualify < tps.unqualify
            return !isLowTps
          })
          .map((provider) => {
            topPriority = Math.min(topPriority, provider.priority)
            return provider
          })
          .filter((p) => p.priority <= topPriority)
          .flatMap((provider) => Array<typeof provider>(provider.weight).fill(provider))

        if (providers.length === 0)
          return acquireProviderFailoverRoute({
            primaryProviders: [],
            fallbackProviders: routes.fallbackProviders,
            strict: modelInfo.stickyProvider === "strict",
            acquire,
          })

        // Use the last 4 characters of session ID to select a provider
        let h = 0
        const l = stickyId.length
        for (let i = l - 4; i < l; i++) {
          h = (h * 31 + stickyId.charCodeAt(i)) | 0 // 32-bit int
        }
        const index = (h >>> 0) % providers.length // make unsigned + range 0..length-1
        const provider = providers[index || 0]

        // sticky provider does not exist => use selected provider
        let preferred = provider
        if (!stickyProviderId) {
          return acquireProviderFailoverRoute({
            primaryProviders: [preferred, ...providers.filter((candidate) => candidate.id !== preferred.id)],
            fallbackProviders: routes.fallbackProviders,
            strict: modelInfo.stickyProvider === "strict",
            acquire,
          })
        }
        const stickProvider = routes.primaryProviders.find((provider) => provider.id === stickyProviderId)
        if (stickProvider) {
          // Preserve the existing sticky preference while its circuit is healthy.
          if (!provider.tpsGoal) preferred = stickProvider
          else {
            const tps = modelTpsLimits?.[`${provider.id}/${provider.model}/${provider.tpsGoal}`] ?? {
              qualify: 0,
              unqualify: 0,
            }
            if (tps.qualify <= tps.unqualify * 3) preferred = stickProvider
          }
        }

        const ordered = [preferred, ...providers.filter((candidate) => candidate.id !== preferred.id)]
        return acquireProviderFailoverRoute({
          primaryProviders: ordered,
          fallbackProviders: routes.fallbackProviders,
          strict: modelInfo.stickyProvider === "strict",
          acquire,
        })
      }

      // fallback provider
      return acquireProviderFailoverRoute({
        primaryProviders: [],
        fallbackProviders: routes.fallbackProviders,
        strict: modelInfo.stickyProvider === "strict",
        acquire,
      })
    })()

    if (!selected) throw new ModelError(t("gateway.api.error.noProviderAvailable"))
    const modelProvider = selected.provider
    if (!(modelProvider.id in catalog.providers))
      throw new ModelError(t("gateway.api.error.providerNotSupported", { provider: modelProvider.id }))

    return {
      ...modelProvider,
      ...catalog.providers[modelProvider.id],
      circuitPermit: selected.circuitPermit,
      ...(() => {
        const providerProps = catalog.providers[modelProvider.id]
        const format = providerProps.format
        const opts = {
          reqModel,
          providerModel: modelProvider.model,
          adjustCacheUsage: providerProps.adjustCacheUsage,
          workspaceID: authInfo?.workspaceID,
        }
        if (format === "anthropic") return anthropicHelper(opts)
        if (format === "google") return googleHelper(opts)
        if (format === "openai") return openaiHelper(opts)
        return oaCompatHelper(opts)
      })(),
    }
  }

  async function authenticate(modelInfo: ModelInfo, gatewayApiKey?: string) {
    if (!gatewayApiKey) {
      if (modelInfo.allowAnonymous) return
      throw new AuthError(t("gateway.api.error.missingApiKey"))
    }

    const data = await (async () => {
      const key = gatewayApiKey ? await loadAuthData(modelInfo, { type: "key", value: gatewayApiKey }) : undefined
      if (key) return key

      const account = await verifyGatewayAccount(input.request, gatewayApiKey)
      if (!account) return undefined
      const workspace = await resolveGatewayWorkspace(account, input.request.headers.get("x-org-id"))
      if (!("workspaceID" in workspace)) {
        if (workspace.error === "workspace_ambiguous") throw new AuthError(t("gateway.api.error.organizationRequired"))
        if (workspace.error === "workspace_required") throw new AuthError(t("gateway.api.error.organizationRequired"))
        return undefined
      }
      return loadAuthData(modelInfo, {
        type: "account",
        accountID: account.accountID,
        workspaceID: workspace.workspaceID,
      })
    })()

    if (!data) throw new AuthError(t("gateway.api.error.invalidApiKey"))
    if (
      modelInfo.id.startsWith("alpha-") &&
      Resource.App.stage === "production" &&
      !freeWorkspaceIDs.has(data.workspaceID)
    )
      throw new AuthError(t("gateway.api.error.modelNotSupported", { model: modelInfo.id }))

    logger.metric({
      workspace: data.workspaceID,
      ...(() => {
        if (data.planEntitlement)
          return {
            subscription: data.planEntitlement.plan,
          }
        return {}
      })(),
    })

    return {
      apiKeyId: data.apiKey,
      workspaceID: data.workspaceID,
      billing: data.billing,
      user: data.user,
      planEntitlement: data.planEntitlement,
      planUsage: data.planUsage,
      provider: data.provider,
      isFree: freeWorkspaceIDs.has(data.workspaceID),
      isDisabled: !!data.timeDisabled,
    }
  }

  function loadAuthData(modelInfo: ModelInfo, credential: AuthCredential) {
    const now = new Date()
    const key =
      credential.type === "key"
        ? and(
            eq(KeyTable.workspaceID, UserTable.workspaceID),
            eq(KeyTable.userID, UserTable.id),
            eq(KeyTable.key, credential.value),
            isNull(KeyTable.timeDeleted),
          )
        : sql`false`
    const account =
      credential.type === "account"
        ? and(eq(UserTable.accountID, credential.accountID), eq(UserTable.workspaceID, credential.workspaceID))
        : eq(KeyTable.key, credential.value)

    return Database.use((tx) =>
      tx
        .select({
          apiKey: KeyTable.id,
          workspaceID: UserTable.workspaceID,
          billing: {
            balance: BillingTable.balance,
            paymentMethodID: BillingTable.paymentMethodID,
            monthlyLimit: BillingTable.monthlyLimit,
            monthlyUsage: BillingTable.monthlyUsage,
            timeMonthlyUsageUpdated: BillingTable.timeMonthlyUsageUpdated,
            reloadTrigger: BillingTable.reloadTrigger,
            timeReloadLockedTill: BillingTable.timeReloadLockedTill,
            subscription: BillingTable.subscription,
          },
          user: {
            id: UserTable.id,
            monthlyLimit: UserTable.monthlyLimit,
            monthlyUsage: UserTable.monthlyUsage,
            timeMonthlyUsageUpdated: UserTable.timeMonthlyUsageUpdated,
          },
          planEntitlement: {
            id: PlanSubscriptionTable.id,
            invoiceID: PlanSubscriptionTable.invoiceID,
            plan: PlanSubscriptionTable.plan,
            timePeriodStart: PlanSubscriptionTable.timePeriodStart,
            timePeriodEnd: PlanSubscriptionTable.timePeriodEnd,
          },
          planUsage: {
            id: SubscriptionTable.id,
            rollingUsage: SubscriptionTable.rollingUsage,
            fixedUsage: SubscriptionTable.fixedUsage,
            weeklyTokens: SubscriptionTable.weeklyTokens,
            weeklyRequests: SubscriptionTable.weeklyRequests,
            monthlyCost: SubscriptionTable.monthlyCost,
            monthlyTokens: SubscriptionTable.monthlyTokens,
            monthlyRequests: SubscriptionTable.monthlyRequests,
            timeRollingUpdated: SubscriptionTable.timeRollingUpdated,
            timeFixedUpdated: SubscriptionTable.timeFixedUpdated,
            timeWeeklyTokensUpdated: SubscriptionTable.timeWeeklyTokensUpdated,
            timeWeeklyRequestsUpdated: SubscriptionTable.timeWeeklyRequestsUpdated,
            timeMonthlyCostUpdated: SubscriptionTable.timeMonthlyCostUpdated,
            timeMonthlyTokensUpdated: SubscriptionTable.timeMonthlyTokensUpdated,
            timeMonthlyRequestsUpdated: SubscriptionTable.timeMonthlyRequestsUpdated,
          },
          provider: {
            credentials: ProviderTable.credentials,
          },
          timeDisabled: ModelTable.timeCreated,
        })
        .from(UserTable)
        .innerJoin(
          AccountTable,
          and(
            eq(AccountTable.id, UserTable.accountID),
            eq(AccountTable.status, "active"),
            isNull(AccountTable.timeDeleted),
          ),
        )
        .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, UserTable.workspaceID))
        .innerJoin(BillingTable, eq(BillingTable.workspaceID, UserTable.workspaceID))
        .leftJoin(KeyTable, key)
        .leftJoin(
          ModelTable,
          and(eq(ModelTable.workspaceID, UserTable.workspaceID), eq(ModelTable.model, modelInfo.id)),
        )
        .leftJoin(
          ProviderTable,
          modelInfo.byokProvider
            ? and(
                eq(ProviderTable.workspaceID, UserTable.workspaceID),
                eq(ProviderTable.provider, modelInfo.byokProvider),
                isNull(ProviderTable.timeDeleted),
              )
            : sql`false`,
        )
        .leftJoin(
          PlanSubscriptionTable,
          and(
            eq(PlanSubscriptionTable.workspaceID, UserTable.workspaceID),
            eq(PlanSubscriptionTable.status, "active"),
            lte(PlanSubscriptionTable.timePeriodStart, now),
            gt(PlanSubscriptionTable.timePeriodEnd, now),
            isNull(PlanSubscriptionTable.timeDeleted),
          ),
        )
        .leftJoin(
          SubscriptionTable,
          and(
            eq(SubscriptionTable.workspaceID, UserTable.workspaceID),
            eq(SubscriptionTable.userID, UserTable.id),
            isNull(SubscriptionTable.timeDeleted),
          ),
        )
        .where(and(account, isNull(UserTable.timeDeleted), isNull(WorkspaceTable.timeDeleted)))
        .orderBy(UserTable.workspaceID)
        .limit(1)
        .then((rows) => rows[0]),
    )
  }

  async function reserveFreeAutoWeeklyUsage(authInfo: AuthInfo, modelInfo: ModelInfo) {
    if (!modelInfo.freeForAuthenticated || !modelInfo.freeWeeklyTokenLimit || !modelInfo.freeMaxTokensPerRequest) return
    if (!authInfo) throw new AuthError(t("gateway.api.error.missingApiKey"))

    const week = getWeekBounds(new Date())
    const usage = await Database.use((db) =>
      db
        .select({
          total: sql<number>`
            COALESCE(SUM(${UsageTable.inputTokens}), 0) +
            COALESCE(SUM(${UsageTable.outputTokens}), 0) +
            COALESCE(SUM(${UsageTable.reasoningTokens}), 0) +
            COALESCE(SUM(${UsageTable.cacheReadTokens}), 0) +
            COALESCE(SUM(${UsageTable.cacheWrite5mTokens}), 0) +
            COALESCE(SUM(${UsageTable.cacheWrite1hTokens}), 0)
          `.as("total"),
        })
        .from(UsageTable)
        .where(
          and(
            eq(UsageTable.workspaceID, authInfo.workspaceID),
            eq(UsageTable.model, modelInfo.id),
            gte(UsageTable.timeCreated, week.start),
          ),
        )
        .then((rows) => Number(rows[0]?.total ?? 0)),
    )
    const result = Subscription.analyzeWeeklyTokens({
      limit: modelInfo.freeWeeklyTokenLimit,
      usage,
      timeUpdated: week.start,
    })
    if (result.status === "rate-limited") throw freeAutoWeeklyLimitError(result.resetInSec)

    const reservation = await reserveFreeAutoQuota({
      workspaceID: authInfo.workspaceID,
      modelID: modelInfo.id,
      weekStart: week.start,
      persistedUsage: usage,
      reservation: freeAutoReservationUpperBound(modelInfo.freeMaxTokensPerRequest, modelInfo.freeWeeklyTokenLimit),
      weeklyLimit: modelInfo.freeWeeklyTokenLimit,
      ttlSeconds: result.resetInSec,
    })
    if (!reservation) throw freeAutoWeeklyLimitError(result.resetInSec)
    return reservation
  }

  async function reservePaidPlanUsage(
    billingSource: BillingSource,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    limits: Limits,
  ) {
    if (billingSource !== "plan") return
    const entitlement = authInfo!.planEntitlement!
    const planLimits = limits.plans[entitlement.plan]
    const reservation = planQuotaReservationBounds({
      weeklyTokenLimit: planLimits.weeklyTokenLimit,
      monthlyTokenLimit: planLimits.monthlyTokenLimit,
      maxTokensPerRequest: modelInfo.maxTokensPerRequest,
      costs: [modelInfo.cost, modelInfo.cost200K],
    })
    const result = await reservePlanQuota({
      workspaceID: authInfo!.workspaceID,
      invoiceID: entitlement.invoiceID,
      userID: authInfo!.user.id,
      now: new Date(),
      timePeriodStart: entitlement.timePeriodStart,
      usage: authInfo!.planUsage ?? undefined,
      limits: planLimits,
      reservation,
    })
    if (result.allowed) return result.reservation

    const retryAfter = Math.max(MINUTE_IN_SECONDS, result.retryAfter)
    if (result.status === "unavailable") {
      throw new QuotaServiceUnavailableError(
        t("gateway.api.error.quotaServiceUnavailable", {
          retryIn: formatRetryTime(retryAfter, locale),
        }),
        retryAfter,
      )
    }
    throw new PlanUsageLimitError(
      t("gateway.api.error.subscriptionQuotaExceeded", {
        retryIn: formatRetryTime(retryAfter, locale),
      }),
      retryAfter,
    )
  }

  function settleRequestQuota(actual?: { costInMicroCents: number; tokens: number }) {
    return Promise.all([
      quota.freeAuto?.settle(actual?.tokens),
      quota.plan?.settle(
        actual && {
          costInMicroCents: actual.costInMicroCents,
          tokens: actual.tokens,
        },
      ),
    ]).then(() => undefined)
  }

  function releaseRequestQuota() {
    return settleRequestQuota({ costInMicroCents: 0, tokens: 0 })
  }

  function freeAutoWeeklyLimitError(retryAfter: number) {
    return new FreeUsageLimitError(
      t("gateway.api.error.freeAutoWeeklyLimitExceeded", {
        retryIn: formatRetryTime(retryAfter, locale),
      }),
      retryAfter,
    )
  }

  function validateBilling(authInfo: AuthInfo, modelInfo: ModelInfo, limits: Limits): BillingSource {
    const immediate = resolveImmediateBillingSource({
      authenticated: !!authInfo,
      hasProviderCredentials: !!authInfo?.provider?.credentials,
      freeForAuthenticated: !!modelInfo.freeForAuthenticated,
      freeWorkspace: !!authInfo?.isFree,
      allowAnonymous: !!modelInfo.allowAnonymous,
    })
    if (immediate) return immediate
    if (!authInfo) throw new AuthError(t("gateway.api.error.missingApiKey"))

    if (authInfo.planEntitlement) {
      try {
        const sub = authInfo.planUsage
        const plan = authInfo.planEntitlement.plan
        const planLimits = limits.plans[plan]

        if (sub?.fixedUsage && sub.timeFixedUpdated) {
          const result = Subscription.analyzeWeeklyUsage({
            limit: planLimits.weeklyCostLimit,
            usage: sub.fixedUsage,
            timeUpdated: sub.timeFixedUpdated,
          })
          if (result.status === "rate-limited")
            throw new PlanUsageLimitError(
              t("gateway.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec, locale),
              }),
              result.resetInSec,
            )
        }

        if (sub?.weeklyTokens && sub.timeWeeklyTokensUpdated) {
          const result = Subscription.analyzeWeeklyTokens({
            limit: planLimits.weeklyTokenLimit,
            usage: sub.weeklyTokens,
            timeUpdated: sub.timeWeeklyTokensUpdated,
          })
          if (result.status === "rate-limited")
            throw new PlanUsageLimitError(
              t("gateway.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec, locale),
              }),
              result.resetInSec,
            )
        }

        if (sub?.weeklyRequests && sub.timeWeeklyRequestsUpdated) {
          const result = Subscription.analyzeWeeklyTokens({
            limit: planLimits.weeklyRequestLimit,
            usage: sub.weeklyRequests,
            timeUpdated: sub.timeWeeklyRequestsUpdated,
          })
          if (result.status === "rate-limited")
            throw new PlanUsageLimitError(
              t("gateway.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec, locale),
              }),
              result.resetInSec,
            )
        }

        if (sub?.monthlyCost && sub.timeMonthlyCostUpdated) {
          const result = Subscription.analyzeMonthlyUsage({
            limit: planLimits.monthlyCostLimit,
            usage: sub.monthlyCost,
            timeUpdated: sub.timeMonthlyCostUpdated,
            timeSubscribed: authInfo.planEntitlement.timePeriodStart,
          })
          if (result.status === "rate-limited")
            throw new PlanUsageLimitError(
              t("gateway.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec, locale),
              }),
              result.resetInSec,
            )
        }

        for (const monthly of [
          {
            limit: planLimits.monthlyTokenLimit,
            usage: sub?.monthlyTokens,
            timeUpdated: sub?.timeMonthlyTokensUpdated,
          },
          {
            limit: planLimits.monthlyRequestLimit,
            usage: sub?.monthlyRequests,
            timeUpdated: sub?.timeMonthlyRequestsUpdated,
          },
        ]) {
          if (!monthly.usage || !monthly.timeUpdated) continue
          const result = Subscription.analyzeMonthlyCount({
            limit: monthly.limit,
            usage: monthly.usage,
            timeUpdated: monthly.timeUpdated,
            timeSubscribed: authInfo.planEntitlement.timePeriodStart,
          })
          if (result.status === "rate-limited")
            throw new PlanUsageLimitError(
              t("gateway.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec, locale),
              }),
              result.resetInSec,
            )
        }

        if (sub?.rollingUsage && sub.timeRollingUpdated) {
          const result = Subscription.analyzeRollingUsage({
            limit: planLimits.rollingCostLimit,
            window: planLimits.rollingWindow,
            usage: sub.rollingUsage,
            timeUpdated: sub.timeRollingUpdated,
          })
          if (result.status === "rate-limited")
            throw new PlanUsageLimitError(
              t("gateway.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec, locale),
              }),
              result.resetInSec,
            )
        }

        return "plan"
      } catch (e) {
        if (!authInfo.billing.subscription?.useBalance) throw e
      }
    }

    // Validate pay as you go billing
    const billing = authInfo.billing
    const workspacePath = `/workspace/${encodeURIComponent(authInfo.workspaceID)}`
    const billingUrl = consolePath(`${workspacePath}/billing`)
    const membersUrl = consolePath(`${workspacePath}/members`)
    if (!billing.paymentMethodID && billing.balance <= 0)
      throw new CreditsError(t("gateway.api.error.noPaymentMethod", { billingUrl }))
    if (billing.balance <= 0) throw new CreditsError(t("gateway.api.error.insufficientBalance", { billingUrl }))

    const now = new Date()
    const currentYear = now.getUTCFullYear()
    const currentMonth = now.getUTCMonth()
    if (
      billing.monthlyLimit &&
      billing.monthlyUsage &&
      billing.timeMonthlyUsageUpdated &&
      billing.monthlyUsage >= centsToMicroCents(billing.monthlyLimit * 100) &&
      currentYear === billing.timeMonthlyUsageUpdated.getUTCFullYear() &&
      currentMonth === billing.timeMonthlyUsageUpdated.getUTCMonth()
    )
      throw new MonthlyLimitError(
        t("gateway.api.error.workspaceMonthlyLimitReached", {
          amount: billing.monthlyLimit,
          billingUrl,
        }),
      )

    if (
      authInfo.user.monthlyLimit &&
      authInfo.user.monthlyUsage &&
      authInfo.user.timeMonthlyUsageUpdated &&
      authInfo.user.monthlyUsage >= centsToMicroCents(authInfo.user.monthlyLimit * 100) &&
      currentYear === authInfo.user.timeMonthlyUsageUpdated.getUTCFullYear() &&
      currentMonth === authInfo.user.timeMonthlyUsageUpdated.getUTCMonth()
    )
      throw new UserLimitError(
        t("gateway.api.error.userMonthlyLimitReached", {
          amount: authInfo.user.monthlyLimit,
          membersUrl,
        }),
      )

    return "balance"
  }

  function validateModelSettings(billingSource: BillingSource, authInfo: AuthInfo) {
    if (billingSource === "anonymous") return
    if (authInfo!.isDisabled) throw new ModelError(t("gateway.api.error.modelDisabled"))
  }

  async function updateProviderKey(authInfo: AuthInfo, modelInfo: ModelInfo, providerInfo: ProviderInfo) {
    if (!authInfo?.provider?.credentials || providerInfo.id !== modelInfo.byokProvider) return
    providerInfo.apiKey = await ProviderCredentials.decrypt({
      workspaceID: authInfo.workspaceID,
      provider: modelInfo.byokProvider,
      credentials: authInfo.provider.credentials,
    })
  }

  function calculateCost(modelInfo: ModelInfo, usageInfo: UsageInfo) {
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } =
      usageInfo

    const modelCost =
      modelInfo.cost200K &&
      inputTokens + (cacheReadTokens ?? 0) + (cacheWrite5mTokens ?? 0) + (cacheWrite1hTokens ?? 0) > 200_000
        ? modelInfo.cost200K
        : modelInfo.cost

    const inputCost = modelCost.input * inputTokens * 100
    const outputCost = modelCost.output * outputTokens * 100
    const cacheReadCost = (() => {
      if (!cacheReadTokens) return undefined
      if (!modelCost.cacheRead) return undefined
      return modelCost.cacheRead * cacheReadTokens * 100
    })()
    const cacheWrite5mCost = (() => {
      if (!cacheWrite5mTokens) return undefined
      if (!modelCost.cacheWrite5m) return undefined
      return modelCost.cacheWrite5m * cacheWrite5mTokens * 100
    })()
    const cacheWrite1hCost = (() => {
      if (!cacheWrite1hTokens) return undefined
      if (!modelCost.cacheWrite1h) return undefined
      return modelCost.cacheWrite1h * cacheWrite1hTokens * 100
    })()
    const totalCostInCent =
      inputCost + outputCost + (cacheReadCost ?? 0) + (cacheWrite5mCost ?? 0) + (cacheWrite1hCost ?? 0)
    return {
      totalCostInCent,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWrite5mCost,
      cacheWrite1hCost,
    }
  }

  function calculateOccurredCost(billingSource: BillingSource, costInfo: CostInfo) {
    return billingSource === "balance" ? (costInfo.totalCostInCent / 100).toFixed(8) : "0"
  }

  function usageTokenTotal(usageInfo: UsageInfo) {
    return (
      usageInfo.inputTokens +
      usageInfo.outputTokens +
      (usageInfo.reasoningTokens ?? 0) +
      (usageInfo.cacheReadTokens ?? 0) +
      (usageInfo.cacheWrite5mTokens ?? 0) +
      (usageInfo.cacheWrite1hTokens ?? 0)
    )
  }

  async function trackUsage(
    sessionId: string,
    billingSource: BillingSource,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    providerInfo: ProviderInfo,
    usageInfo: UsageInfo,
    costInfo: CostInfo,
    limits: Limits,
  ) {
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } =
      usageInfo
    const { totalCostInCent, inputCost, outputCost, cacheReadCost, cacheWrite5mCost, cacheWrite1hCost } = costInfo

    logger.metric({
      "tokens.input": inputTokens,
      "tokens.output": outputTokens,
      "tokens.reasoning": reasoningTokens,
      "tokens.cache_read": cacheReadTokens,
      "tokens.cache_write_5m": cacheWrite5mTokens,
      "tokens.cache_write_1h": cacheWrite1hTokens,
      "cost.input.microcents": centsToMicroCents(inputCost),
      "cost.output.microcents": centsToMicroCents(outputCost),
      "cost.cache_read.microcents": cacheReadCost ? centsToMicroCents(cacheReadCost) : undefined,
      "cost.cache_write.microcents": cacheWrite5mCost ? centsToMicroCents(cacheWrite5mCost) : undefined,
      "cost.total.microcents": centsToMicroCents(totalCostInCent),
      // deprecated - remove after May 20, 2026
      "cost.input": Math.round(inputCost),
      "cost.output": Math.round(outputCost),
      "cost.cache_read": cacheReadCost ? Math.round(cacheReadCost) : undefined,
      "cost.cache_write_5m": cacheWrite5mCost ? Math.round(cacheWrite5mCost) : undefined,
      "cost.cache_write_1h": cacheWrite1hCost ? Math.round(cacheWrite1hCost) : undefined,
      "cost.total": Math.round(totalCostInCent),
    })

    if (billingSource === "anonymous") return
    authInfo = authInfo!

    const cost = centsToMicroCents(totalCostInCent)
    const inputCostInMicroCents = centsToMicroCents(inputCost)
    const outputCostInMicroCents = centsToMicroCents(outputCost)
    const cacheReadCostInMicroCents = cacheReadCost ? centsToMicroCents(cacheReadCost) : undefined
    const cacheWriteCostInMicroCents =
      cacheWrite5mCost || cacheWrite1hCost
        ? centsToMicroCents((cacheWrite5mCost ?? 0) + (cacheWrite1hCost ?? 0))
        : undefined
    const totalTokens = usageTokenTotal(usageInfo)
    const now = new Date()
    const nowMs = now.getTime()
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const usageID = Identifier.create("usage")
    const cf = (input.request as Request & { cf?: { country?: string; continent?: string } }).cf
    const country = locationCode(cf?.country ?? input.request.headers.get("cf-ipcountry") ?? undefined)
    const continent = locationCode(cf?.continent)
    const enrichment = (() => {
      if (billingSource === "plan") return { plan: authInfo.planEntitlement!.plan }
      if (billingSource === "byok") return { plan: "byok" as const }
      if (billingSource === "balance") return { plan: "balance" as const }
      return undefined
    })()
    const queueEligible = billingSource !== "plan" && HOT_WORKSPACES.has(authInfo.workspaceID)
    const queuedWorkspaceCost = billingSource === "free" || billingSource === "byok" ? 0 : cost

    if (queueEligible) {
      try {
        await enqueueBatchedUsage({
          version: 1,
          id: usageID,
          workspaceID: authInfo.workspaceID,
          userID: authInfo.user.id,
          timeCreated: nowMs,
          workspaceCost: queuedWorkspaceCost,
          userCost: cost,
          usage: {
            model: modelInfo.id,
            provider: providerInfo.id,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cacheReadTokens,
            cacheWrite5mTokens,
            cacheWrite1hTokens,
            cost,
            inputCost: inputCostInMicroCents,
            outputCost: outputCostInMicroCents,
            cacheReadCost: cacheReadCostInMicroCents,
            cacheWriteCost: cacheWriteCostInMicroCents,
            country,
            continent,
            keyID: authInfo.apiKeyId ?? undefined,
            sessionID: sessionId.substring(0, 30),
            enrichment,
          },
        })
        return { costInMicroCents: cost }
      } catch (error) {
        // The D1 primary-key makes a late Queue delivery and this synchronous fallback idempotent.
        console.error("Хэрэглээний дарааллыг ашиглах боломжгүй тул D1 рүү шилжиж байна", { usageID, error })
      }
    }

    const planUsageRecorded = await Database.transaction(async (db) => {
      const inserted = await db
        .insert(UsageTable)
        .values({
          workspaceID: authInfo.workspaceID,
          id: usageID,
          timeCreated: now,
          timeUpdated: now,
          model: modelInfo.id,
          provider: providerInfo.id,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWrite5mTokens,
          cacheWrite1hTokens,
          cost,
          inputCost: inputCostInMicroCents,
          outputCost: outputCostInMicroCents,
          cacheReadCost: cacheReadCostInMicroCents,
          cacheWriteCost: cacheWriteCostInMicroCents,
          country,
          continent,
          userID: authInfo.user.id,
          keyID: authInfo.apiKeyId,
          sessionID: sessionId.substring(0, 30),
          enrichment,
        })
        .onConflictDoNothing()
      if (inserted.meta.changes === 0) return true

      await recordEstimatedModelCostWithDb(db, {
        workspaceID: authInfo.workspaceID,
        usageID,
        provider: providerInfo.id,
        model: modelInfo.id,
        costUSDInMicrocents: cost,
        effectiveAt: nowMs,
        plan: enrichment?.plan,
      })

      if (billingSource === "plan") {
        const plan = authInfo.planEntitlement!.plan
        const planLimits = limits.plans[plan]
        return recordPlanUsageWithDb(db, {
          workspaceID: authInfo.workspaceID,
          userID: authInfo.user.id,
          entitlementID: authInfo.planEntitlement!.id,
          costInMicroCents: cost,
          tokens: totalTokens,
          rollingWindowHours: planLimits.rollingWindow,
          now,
        })
      }

      const updates = await (async () => {
        const workspaceDelta = queueEligible ? queuedWorkspaceCost : cost
        const userDelta = cost
        const balanceDelta = billingSource === "free" || billingSource === "byok" ? 0 : workspaceDelta

        return [
          db
            .update(BillingTable)
            .set({
              balance: sql`${BillingTable.balance} - ${balanceDelta}`,
              monthlyUsage: sql`
              CASE
                WHEN ${BillingTable.timeMonthlyUsageUpdated} >= ${currentMonthStart.getTime()} THEN COALESCE(${BillingTable.monthlyUsage}, 0) + ${workspaceDelta}
                ELSE ${workspaceDelta}
              END
            `,
              timeMonthlyUsageUpdated: now,
            })
            .where(eq(BillingTable.workspaceID, authInfo.workspaceID)),
          db
            .update(UserTable)
            .set({
              monthlyUsage: sql`
              CASE
                WHEN ${UserTable.timeMonthlyUsageUpdated} >= ${currentMonthStart.getTime()} THEN COALESCE(${UserTable.monthlyUsage}, 0) + ${userDelta}
                ELSE ${userDelta}
              END
            `,
              timeMonthlyUsageUpdated: now,
            })
            .where(and(eq(UserTable.workspaceID, authInfo.workspaceID), eq(UserTable.id, authInfo.user.id))),
        ]
      })()
      await Promise.all(updates)
      return true
    })

    if (!planUsageRecorded) {
      throw new PlanUsageLimitError(
        t("gateway.api.error.subscriptionQuotaExceeded", {
          retryIn: formatRetryTime(MINUTE_IN_SECONDS, locale),
        }),
        MINUTE_IN_SECONDS,
      )
    }

    return { costInMicroCents: cost }
  }
}
