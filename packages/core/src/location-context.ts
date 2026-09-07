import { Context } from "effect"
import { Info } from "@mongolgpt/schema/location"
import type { ProjectSchema } from "./project/schema"

export type { Ref } from "@mongolgpt/schema/location"

// Event storage needs location identity without loading project command services.
export interface Interface extends Info {
  readonly vcs?: ProjectSchema.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@mongolgpt/Location") {}

export * as Location from "./location-context"
