import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { withCliFixture } from "./cli-process"
import { it } from "./effect"

for (const method of ["spawn", "run"] as const) {
  const name = `cli-process ${method} isolates subprocess env`

  if (!process.env.CLI_PROCESS_ENV_TEST_CHILD) {
    it.live(
      name,
      () =>
        Effect.gen(function* () {
          // Pollution stays in a separate test process, away from concurrent tests.
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", name], {
                cwd: path.resolve(import.meta.dir, "../.."),
                env: { ...process.env, CLI_PROCESS_ENV_TEST_CHILD: method },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            ),
            (child) =>
              Effect.promise(async () => {
                if (child.exitCode === null) child.kill()
                await child.exited
              }),
          )
          const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
            Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
          ).pipe(Effect.timeout("50 seconds"))
          expect(exitCode, stdout + stderr).toBe(0)
        }),
      60_000,
    )
  }

  if (process.env.CLI_PROCESS_ENV_TEST_CHILD === method) {
    it.live(
      name,
      () =>
        Effect.gen(function* () {
          const pollution = {
            CLI_PROCESS_API_KEY: "parent-api-key",
            CLI_PROCESS_CUSTOM_SECRET: "parent-secret",
            CLI_PROCESS_ACCESS_TOKEN: "parent-token",
            MONGOLGPT_CLI_ENV_SENTINEL: "parent-switch",
            mongolgpt_cli_env_lower: "parent-lowercase-switch",
            CLI_PROCESS_EXPLICIT_SECRET: "parent-explicit-secret",
            MONGOLGPT_CLI_ENV_EXPLICIT: "parent-explicit-switch",
            CLI_PROCESS_PUBLIC: "parent-public",
            CLI_PROCESS_HOST_VALUE: "host-value",
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const original = Object.keys(pollution).map((key) => [key, process.env[key]] as const)
              Object.assign(process.env, pollution)
              return original
            }),
            (original) =>
              Effect.sync(() => {
                for (const [key, value] of original) {
                  if (value === undefined) {
                    delete process.env[key]
                    continue
                  }
                  process.env[key] = value
                }
              }),
          )
          yield* withCliFixture(({ home, mongolgpt }) =>
            Effect.gen(function* () {
              const overrides = {
                CLI_PROCESS_EXPLICIT_SECRET: "explicit-secret",
                MONGOLGPT_CLI_ENV_EXPLICIT: "explicit-switch",
                CLI_PROCESS_PUBLIC: "explicit-public",
                XDG_CACHE_HOME: path.join(home, "explicit-cache"),
              }
              const expected: Record<string, string | null> = {
                CLI_PROCESS_API_KEY: null,
                CLI_PROCESS_CUSTOM_SECRET: null,
                CLI_PROCESS_ACCESS_TOKEN: null,
                MONGOLGPT_CLI_ENV_SENTINEL: null,
                mongolgpt_cli_env_lower: null,
                CLI_PROCESS_HOST_VALUE: "host-value",
                CLI_PROCESS_EXPLICIT_SECRET: overrides.CLI_PROCESS_EXPLICIT_SECRET,
                MONGOLGPT_CLI_ENV_EXPLICIT: overrides.MONGOLGPT_CLI_ENV_EXPLICIT,
                CLI_PROCESS_PUBLIC: overrides.CLI_PROCESS_PUBLIC,
              }
              Object.assign(
                expected,
                Object.fromEntries(
                  Object.entries(process.env).filter(([key]) =>
                    /^(path|pathext|systemroot|windir|comspec|shell|temp|tmp)$/i.test(key),
                  ),
                ),
                {
                  HOME: home,
                  MONGOLGPT_TEST_HOME: home,
                  MONGOLGPT_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
                  XDG_CACHE_HOME: overrides.XDG_CACHE_HOME,
                },
              )
              // Read the real child env before CLI boot; only named probes are printed.
              yield* Effect.promise(() =>
                Bun.write(
                  path.join(home, "env-probe.ts"),
                  `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(expected))}.map(key => [key, process.env[key] ?? null])))); process.exit(0)`,
                ),
              )
              const options = {
                env: {
                  ...overrides,
                  BUN_OPTIONS: "--preload=./env-probe.ts",
                },
              }
              const result = yield* method === "spawn"
                ? mongolgpt.spawn(["debug", "config"], options)
                : mongolgpt.run("check env isolation", options)
              mongolgpt.expectExit(result, 0)
              expect(result.timedOut).toBe(false)
              expect(result.stdout.startsWith("{"), result.stdout + result.stderr).toBe(true)
              expect(JSON.parse(result.stdout)).toEqual(expected)
            }),
          )
        }),
      45_000,
    )
  }
}
