import { z } from "zod"
import { fn } from "./util/fn"
import { LegacyPlanCodes } from "./schema/billing.sql"
import { PlanData } from "./plan"

/** @deprecated Use PlanData. Kept only while legacy maintenance scripts are migrated. */
export namespace BlackData {
  export const getLimits = fn(
    z.object({
      plan: z.enum(LegacyPlanCodes),
    }),
    ({ plan }) => {
      const limits = PlanData.getLimits({ plan: PlanData.fromLegacyCode({ code: plan }) })
      return {
        fixedLimit: limits.weeklyCostLimit,
        rollingLimit: limits.rollingCostLimit,
        rollingWindow: limits.rollingWindow,
      }
    },
  )

  export const productID = PlanData.productID

  export const planToPriceID = fn(
    z.object({
      plan: z.enum(LegacyPlanCodes),
    }),
    ({ plan }) => PlanData.planToPriceID({ plan: PlanData.fromLegacyCode({ code: plan }) }),
  )

  export const priceIDToPlan = fn(
    z.object({
      priceID: z.string(),
    }),
    ({ priceID }) => {
      return PlanData.toLegacyCode({ plan: PlanData.priceIDToPlan({ priceID }) })
    },
  )
}
