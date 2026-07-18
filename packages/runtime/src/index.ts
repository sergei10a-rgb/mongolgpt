import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox"
import { createRuntimeHandler, type RuntimeVariables } from "./runtime"

export { ContainerProxy }

export const blockedEgressHosts = [
  "localhost",
  "*.localhost",
  "*.local",
  "metadata.google.internal",
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "::1",
  "fc00::/7",
  "fe80::/10",
]

export class MongolGPTSandbox extends Sandbox {
  enableInternet = false
  allowedHosts = ["*"]
  deniedHosts = blockedEgressHosts
}

interface RuntimeEnvironment extends RuntimeVariables {
  Sandbox: DurableObjectNamespace<MongolGPTSandbox>
}

const handler = createRuntimeHandler<RuntimeEnvironment>({
  fetch: (request) => fetch(request),
  sandbox: (env, id) =>
    getSandbox(env.Sandbox, id, {
      normalizeId: true,
      sleepAfter: "10m",
      transport: "rpc",
    }),
  report: (error) => {
    console.error("MongolGPT runtime request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    })
  },
})

export default {
  fetch(request, env) {
    return handler(request, env)
  },
} satisfies ExportedHandler<RuntimeEnvironment>
