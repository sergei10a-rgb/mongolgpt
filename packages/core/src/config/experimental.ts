export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Literals(["provider.use"])
export const PolicyEffect = Schema.Literals(["allow", "deny"]).annotate({ identifier: "Policy.Effect" })

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  action: PolicyAction,
  effect: PolicyEffect,
  resource: Schema.String,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
}) {}
