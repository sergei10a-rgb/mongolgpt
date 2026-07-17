import type { KVNamespaceListOptions, KVNamespaceListResult, KVNamespacePutOptions } from "@cloudflare/workers-types"
import { Resource as ResourceBase } from "sst"
import Cloudflare from "cloudflare"
import { createRemoteD1 } from "./remote-d1"

export const waitUntil = async (promise: Promise<any>) => {
  await promise
}

export const Resource = new Proxy(
  {},
  {
    get(_target, prop: keyof typeof ResourceBase) {
      const value = ResourceBase[prop]
      const secrets = ResourceBase as unknown as Record<string, { value: string }>
      if ("type" in value) {
        // @ts-ignore
        if (value.type === "sst.cloudflare.Bucket") {
          return {
            put: async () => {},
          }
        }
        // @ts-ignore
        if (value.type === "sst.cloudflare.Kv") {
          const client = new Cloudflare({
            apiToken: secrets.CLOUDFLARE_API_TOKEN.value,
          })
          // @ts-ignore
          const namespaceId = value.namespaceId
          const accountId = secrets.CLOUDFLARE_DEFAULT_ACCOUNT_ID.value
          return {
            get: (k: string | string[]) => {
              const isMulti = Array.isArray(k)
              return client.kv.namespaces
                .bulkGet(namespaceId, {
                  keys: Array.isArray(k) ? k : [k],
                  account_id: accountId,
                })
                .then((result) => (isMulti ? new Map(Object.entries(result?.values ?? {})) : result?.values?.[k]))
            },
            put: (k: string, v: string, opts?: KVNamespacePutOptions) =>
              client.kv.namespaces.values.update(namespaceId, k, {
                account_id: accountId,
                value: v,
                expiration: opts?.expiration,
                expiration_ttl: opts?.expirationTtl,
                metadata: opts?.metadata,
              }),
            delete: (k: string) =>
              client.kv.namespaces.values.delete(namespaceId, k, {
                account_id: accountId,
              }),
            list: (opts?: KVNamespaceListOptions): Promise<KVNamespaceListResult<unknown, string>> =>
              client.kv.namespaces.keys
                .list(namespaceId, {
                  account_id: accountId,
                  prefix: opts?.prefix ?? undefined,
                })
                .then((result) => {
                  return {
                    keys: result.result,
                    list_complete: true,
                    cacheStatus: null,
                  }
                }),
          }
        }
        // @ts-ignore
        if (value.type === "sst.cloudflare.D1") {
          const token = secrets.CLOUDFLARE_API_TOKEN?.value ?? process.env.CLOUDFLARE_API_TOKEN
          const accountId = secrets.CLOUDFLARE_DEFAULT_ACCOUNT_ID?.value ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
          if (!token || !accountId) {
            throw new Error("Local D1 access requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_DEFAULT_ACCOUNT_ID.")
          }
          return createRemoteD1({
            accountId,
            // @ts-ignore
            databaseId: value.databaseId,
            apiToken: token,
          })
        }
        // @ts-ignore
        if (value.type === "sst.cloudflare.Worker") {
          // @ts-ignore
          const workerUrl = value.url
          if (!workerUrl) throw new Error(`Local worker access for ${String(prop)} requires its SST url option.`)
          return {
            ...value,
            fetch: (input: RequestInfo | URL, init?: RequestInit) => {
              const incoming = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
              const target = new URL(workerUrl)
              target.pathname = incoming.pathname
              target.search = incoming.search
              return fetch(target, init)
            },
          }
        }
      }
      return value
    },
  },
) as Record<string, any>
