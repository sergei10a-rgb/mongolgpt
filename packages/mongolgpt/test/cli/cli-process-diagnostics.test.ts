import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Exit } from "effect"
import { cliIt, createCliProcessDiagnostics } from "../lib/cli-process"

const privateFixture = "fixture-private-oauth-code-state-token"
const fixtureEnv = { MONGOLGPT_ACCOUNT_TOKEN_KEY: Buffer.alloc(32, 37).toString("base64url") }

describe("CLI subprocess diagnostics", () => {
  test("reports actual process exit, byte counts, and ACP request metadata without private output", async () => {
    const stdout = JSON.stringify({ token: privateFixture, protocol: "\u00e9" })
    const stderrLine = `Bearer ${privateFixture}\n`
    const stderr = stderrLine.repeat(4096)
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderrLine)}.repeat(4096)); process.exitCode = 7`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const messages: string[] = []
    const diagnostics = createCliProcessDiagnostics(proc, "acp", (message) => messages.push(message))
    const timer = setTimeout(() => proc.kill(), 5000)
    const drain = async (name: "stdout" | "stderr", stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          diagnostics.count(name, chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
    }
    try {
      await Promise.all([drain("stdout", proc.stdout), drain("stderr", proc.stderr), proc.exited])
      diagnostics.request({ method: "initialize", id: 41, params: { code: privateFixture, state: privateFixture } })
      const result = await Effect.runPromiseExit(diagnostics.receive(Effect.never).pipe(Effect.timeout("20 millis")))
      expect(Exit.isFailure(result)).toBe(true)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("ACP receive interrupted")
      expect(JSON.parse(diagnostics.summary())).toEqual({
        command: "acp",
        pid: proc.pid,
        exitCode: 7,
        signalCode: null,
        elapsedMs: expect.any(Number),
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        lastRequest: { method: "initialize", id: 41 },
      })
      expect(messages[0]!.length).toBeLessThan(1024)
      expect(messages[0]).not.toContain(privateFixture)
      expect(messages[0]).not.toContain("Bearer")

      diagnostics.request({ method: privateFixture, id: privateFixture, params: { token: privateFixture } })
      expect(JSON.parse(diagnostics.summary()).lastRequest).toEqual({ method: "unknown", id: null })
      expect(diagnostics.summary()).not.toContain(privateFixture)
      await Effect.runPromiseExit(diagnostics.receive(Effect.never).pipe(Effect.timeout("20 millis")))
      expect(messages).toHaveLength(1)
      expect(await Effect.runPromise(diagnostics.receive(Effect.succeed("received")))).toBe("received")
    } finally {
      clearTimeout(timer)
      if (proc.exitCode === null) proc.kill()
      await proc.exited
    }
  }, 15_000)

  cliIt.live("output wait timeout omits the pattern, environment, and caller-provided failure label", ({ mongolgpt }) =>
    Effect.gen(function* () {
      const command = yield* mongolgpt.start(["serve", "--port", "0"], { env: fixtureEnv })
      const error = yield* Effect.flip(command.waitForOutput(new RegExp(privateFixture), 50))
      expect(error.message).toContain("output was not observed within 50ms")
      const metadata = JSON.parse(error.message.split("\n")[1]!)
      expect(metadata.command).toBe("start")
      expect(metadata.pid).toBeGreaterThan(0)
      expect(metadata.elapsedMs).toBeGreaterThanOrEqual(50)
      expect(metadata.stdoutBytes).toBeGreaterThanOrEqual(0)
      expect(metadata.stderrBytes).toBeGreaterThanOrEqual(0)
      expect(metadata).toHaveProperty("exitCode")
      expect(metadata).toHaveProperty("signalCode")
      expect(error.message).not.toContain(privateFixture)
      expect(error.message).not.toContain(fixtureEnv.MONGOLGPT_ACCOUNT_TOKEN_KEY)

      const failed = Effect.try({
        try: () =>
          mongolgpt.expectExit(
            { exitCode: 1, durationMs: 10, timedOut: false, stdout: privateFixture, stderr: privateFixture },
            0,
            privateFixture,
          ),
        catch: (cause) => (cause instanceof Error ? cause : new Error("unexpected failure")),
      })
      const failure = yield* Effect.flip(failed)
      expect(String(failure)).not.toContain(privateFixture)
      expect(String(failure)).toContain("stdoutBytes")
    }),
  )

  cliIt.live("serve readiness timeout contains lifecycle metadata without child output", ({ mongolgpt }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(mongolgpt.serve({ readyTimeoutMs: 1, env: fixtureEnv }))
      expect(error.message).toContain("serve did not become ready within 1ms")
      const metadata = JSON.parse(error.message.split("\n")[1]!)
      expect(metadata.command).toBe("serve")
      expect(metadata.pid).toBeGreaterThan(0)
      expect(metadata.stdoutBytes).toBeGreaterThanOrEqual(0)
      expect(metadata.stderrBytes).toBeGreaterThanOrEqual(0)
      expect(error.message.length).toBeLessThan(1024)
      expect(error.message).not.toContain(fixtureEnv.MONGOLGPT_ACCOUNT_TOKEN_KEY)
    }),
  )

  cliIt.live("the real ACP harness reports method and id when its caller times out", ({ mongolgpt }) =>
    Effect.gen(function* () {
      const messages: string[] = []
      const capture = spyOn(console, "error").mockImplementation((message: string) => messages.push(message))
      yield* Effect.gen(function* () {
        const acp = yield* mongolgpt.acp({ env: fixtureEnv })
        yield* acp.send({ jsonrpc: "2.0", method: "initialize", id: 73, params: { token: privateFixture } })
        const result = yield* acp.receive.pipe(
          Effect.timeoutOrElse({ duration: "1 millis", orElse: () => Effect.succeed("timed out") }),
        )
        expect(result).toBe("timed out")
        expect(messages).toHaveLength(1)
        expect(messages[0]).toContain("ACP receive interrupted")
        expect(messages[0]).toContain('"lastRequest":{"method":"initialize","id":73}')
        expect(messages[0]).toContain('"pid":')
        expect(messages[0]).not.toContain(privateFixture)
        expect(messages[0]).not.toContain(fixtureEnv.MONGOLGPT_ACCOUNT_TOKEN_KEY)
      }).pipe(Effect.ensuring(Effect.sync(() => capture.mockRestore())))
    }),
  )
})
