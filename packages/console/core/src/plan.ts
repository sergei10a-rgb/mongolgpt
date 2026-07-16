import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"
import { fn } from "./util/fn"
import { LegacyPlanCodes, PlanNames } from "./schema/billing.sql"
import { Subscription } from "./subscription"

export namespace PlanData {
  export const getLimits = fn(
    z.object({
      plan: z.enum(PlanNames),
    }),
    ({ plan }) => Subscription.getLimits().plans[plan],
  )

  export const productID = fn(z.void(), () => Resource.MONGOLGPT_PLAN_PRICE.product)

  export const planToPriceID = fn(
    z.object({
      plan: z.enum(PlanNames),
    }),
    ({ plan }) => Resource.MONGOLGPT_PLAN_PRICE[plan],
  )

  export const priceIDToPlan = fn(
    z.object({
      priceID: z.string(),
    }),
    ({ priceID }) => {
      const plan = PlanNames.find((name) => Resource.MONGOLGPT_PLAN_PRICE[name] === priceID)
      if (!plan) throw new Error("Төлбөрийн төлөвлөгөөний үнэ танигдсангүй")
      return plan
    },
  )

  export const fromLegacyCode = fn(
    z.object({
      code: z.enum(LegacyPlanCodes),
    }),
    ({ code }) => {
      if (code === "20") return "basic" as const
      if (code === "100") return "pro" as const
      return "max" as const
    },
  )

  export const toLegacyCode = fn(
    z.object({
      plan: z.enum(PlanNames),
    }),
    ({ plan }) => {
      if (plan === "basic") return "20" as const
      if (plan === "pro") return "100" as const
      return "200" as const
    },
  )
}
