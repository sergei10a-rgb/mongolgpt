export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@mongolgpt/schema/event"
import { EventManifest } from "@mongolgpt/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
