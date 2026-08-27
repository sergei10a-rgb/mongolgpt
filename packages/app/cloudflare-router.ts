import { routeStaticAppRequest, type StaticAssetsBinding } from "./src/utils/static-app-router"

interface Environment {
  ASSETS: StaticAssetsBinding
}

export default {
  fetch(request: Request, env: Environment) {
    return routeStaticAppRequest(request, env.ASSETS)
  },
}
