import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createMongolGPTClient } from "@mongolgpt/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

function stdinStream() {
  let resolveEnded!: () => void
  let rejectEnded!: (error: unknown) => void
  const ended = new Promise<void>((resolve, reject) => {
    resolveEnded = resolve
    rejectEnded = reject
  })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false
      const cleanup = () => {
        process.stdin.off("data", onData)
        process.stdin.off("end", onEnd)
        process.stdin.off("close", onEnd)
        process.stdin.off("error", onError)
      }
      const onData = (chunk: Buffer) => {
        if (!settled) controller.enqueue(new Uint8Array(chunk))
      }
      const onEnd = () => {
        if (settled) return
        settled = true
        cleanup()
        controller.close()
        resolveEnded()
      }
      const onError = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        controller.error(error)
        rejectEnded(error)
      }

      process.stdin.on("data", onData)
      process.stdin.once("end", onEnd)
      process.stdin.once("close", onEnd)
      process.stdin.once("error", onError)

      // A client may close the pipe before this command finishes its cold start.
      // Node does not replay the `end` event for listeners registered afterwards.
      if (process.stdin.readableEnded || process.stdin.destroyed) onEnd()
    },
  })

  return { stream, ended }
}

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "ACP (агент-клиентийн протокол) сервер эхлүүлэх",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "ажлын хавтас",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    process.env.MONGOLGPT_CLIENT = "acp"
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))

    yield* Effect.gen(function* () {
      const sdk = createMongolGPTClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
        headers: ServerAuth.headers(),
      })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const stdin = stdinStream()

      const stream = ndJsonStream(input, stdin.stream)
      const agent = ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        ACPProfile.mark("cli.acp.connection.create")
        return agent.create(conn)
      }, stream)

      yield* Effect.logInfo("холболт тохирууллаа")
      process.stdin.resume()
      yield* Effect.promise(() => stdin.ended)
    }).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)).pipe(Effect.ignore)))
  }),
})
