export * from "./client.js"
export * from "./server.js"

import { createMongolGPTClient } from "./client.js"
import { createMongolGPTServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createMongolGPT(options?: ServerOptions) {
  const server = await createMongolGPTServer({
    ...options,
  })

  const client = createMongolGPTClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
