import { lookup } from "node:dns/promises"

import {
  isBlockedAccountAddress,
  isLoopbackAccountServer,
  validateAccountServerUrl,
  validateConfiguredAccountServerUrl,
} from "./url"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type AccountDnsAddress = { readonly address: string; readonly family: number }
export type AccountDnsLookup = (hostname: string) => Promise<readonly AccountDnsAddress[]>
export type AccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AccountTransport = {
  readonly url: string
  readonly fetch: AccountFetch
}

export const defaultAccountDnsLookup: AccountDnsLookup = (hostname) =>
  lookup(hostname, { all: true, verbatim: true })

export async function resolveAccountTransport(
  input: string,
  options: { readonly resolveDns: AccountDnsLookup; readonly allowCustomAccountServer?: boolean },
): Promise<AccountTransport> {
  const url = options.allowCustomAccountServer
    ? validateAccountServerUrl(input)
    : validateConfiguredAccountServerUrl(input)
  const parsed = new URL(url)
  if (isLoopbackAccountServer(parsed)) {
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "")
    const address = hostname === "localhost" ? "127.0.0.1" : hostname
    return { url, fetch: createPinnedAccountFetch(url, { address, family: address.includes(":") ? 6 : 4 }) }
  }

  const addresses = await options.resolveDns(parsed.hostname)
  if (addresses.length === 0) throw new Error("Account серверийн DNS хаяг олдсонгүй")
  if (addresses.some((entry) => isBlockedAccountAddress(entry.address))) {
    throw new Error("Account сервер private эсвэл reserved сүлжээ рүү зааж байна")
  }
  return { url, fetch: createPinnedAccountFetch(url, addresses[0]) }
}

export function createPinnedAccountFetch(origin: string, target: AccountDnsAddress): AccountFetch {
  const expectedOrigin = new URL(origin).origin
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "manual" })
    if (new URL(request.url).origin !== expectedOrigin) {
      throw new Error("Account хүсэлт баталгаажсан origin-оос гарлаа")
    }
    return sendPinnedRequest(request, target)
  }
}

async function sendPinnedRequest(request: Request, target: AccountDnsAddress) {
  const url = new URL(request.url)
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.from(await request.arrayBuffer())
  const transport = url.protocol === "https:" ? await import("node:https") : await import("node:http")

  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(request.headers.entries())
    headers.host = url.host
    const outgoing = transport.request(
      {
        protocol: url.protocol,
        hostname: target.address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        signal: request.signal,
      },
      (incoming) => {
        const chunks: Buffer[] = []
        let size = 0

        incoming.on("data", (chunk: Buffer) => {
          size += chunk.byteLength
          if (size <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk)
            return
          }
          incoming.destroy(new Error("Account серверийн хариу зөвшөөрөгдсөн хэмжээнээс хэтэрлээ"))
        })
        incoming.once("error", reject)
        incoming.once("end", () => {
          const responseHeaders = new Headers()
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
          }
          const status = incoming.statusCode ?? 500
          resolve(
            new Response(request.method === "HEAD" || status === 204 || status === 304 ? null : Buffer.concat(chunks), {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            }),
          )
        })
      },
    )
    outgoing.once("error", reject)
    outgoing.end(body)
  })
}

export * as AccountTransport from "./transport"
