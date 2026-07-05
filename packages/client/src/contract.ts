import { makeDefaultApi } from "@mongolgpt/protocol/api"
import { InvalidRequestError, SessionNotFoundError } from "@mongolgpt/protocol/errors"
import { HttpApi, HttpApiMiddleware } from "effect/unstable/httpapi"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()(
  "@mongolgpt/client/LocationMiddleware",
) {}

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "@mongolgpt/client/SessionLocationMiddleware",
  { error: [InvalidRequestError, SessionNotFoundError] },
) {}

const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const SessionGroup = Api.groups["server.session"]
export const EventGroup = Api.groups["server.event"]
export const ClientApi = HttpApi.make("mongolgpt-client").add(SessionGroup).add(EventGroup)
