import type { Argv, InferredOptionTypes } from "yargs"
import { ConfigV1 } from "@mongolgpt/core/v1/config/config"
import type { Config } from "@/config/config"
import { Effect } from "effect"

const options = {
  port: {
    type: "number" as const,
    describe: "сонсох port",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "сонсох hostname",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "mDNS service discovery идэвхжүүлэх (hostname-ийн анхдагч утгыг 0.0.0.0 болгоно)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "mDNS service-ийн custom domain нэр (анхдагч: mongolgpt.local)",
    default: "mongolgpt.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "CORS-д зөвшөөрөх нэмэлт domain-ууд",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return resolveNetworkOptionsNoConfig(args, config)
})

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: ConfigV1.Info) {
  const portExplicitlySet = process.argv.includes("--port")
  const hostnameExplicitlySet = process.argv.includes("--hostname")
  const mdnsExplicitlySet = process.argv.includes("--mdns")
  const mdnsDomainExplicitlySet = process.argv.includes("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  return { hostname, port, mdns, mdnsDomain, cors }
}
