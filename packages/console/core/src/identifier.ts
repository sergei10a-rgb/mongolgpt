import { ulid } from "ulid"
import { z } from "zod"

export namespace Identifier {
  const prefixes = {
    account: "acc",
    accountDeletion: "adl",
    auth: "aut",
    benchmark: "ben",
    billing: "bil",
    financeCost: "fce",
    financeCostValuation: "fvl",
    financeFxRate: "fxr",
    financePaymentSettlement: "fps",
    key: "key",
    lite: "lit",
    model: "mod",
    payment: "pay",
    paymentEvent: "pev",
    paymentInvoice: "inv",
    provider: "prv",
    referral: "ref",
    subscription: "sub",
    usage: "usg",
    user: "usr",
    workspace: "wrk",
  } as const

  export function create(prefix: keyof typeof prefixes, given?: string): string {
    if (given) {
      if (given.startsWith(prefixes[prefix])) return given
      throw new Error(`ID ${given} нь ${prefixes[prefix]}-ээр эхлэхгүй байна`)
    }
    return [prefixes[prefix], ulid()].join("_")
  }

  export function schema(prefix: keyof typeof prefixes) {
    return z.string().startsWith(prefixes[prefix])
  }
}
