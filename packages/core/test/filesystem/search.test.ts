import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { FileSystem, Entry } from "@mongolgpt/core/filesystem"
import { FileSystemSearch } from "@mongolgpt/core/filesystem/search"
import { FSUtil } from "@mongolgpt/core/fs-util"
import { Location } from "@mongolgpt/core/location"
import { Ripgrep } from "@mongolgpt/core/ripgrep"
import { AbsolutePath, RelativePath } from "@mongolgpt/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect, windowsTestTimeout } from "../lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live.serial(
    "globs files as an array",
    () =>
      withTmp((cwd) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
          const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
          expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
        }),
      ),
    windowsTestTimeout(30_000),
  )

  it.live.serial(
    "greps files with include filtering",
    () =>
      withTmp((cwd) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
          const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
          expect(result).toHaveLength(1)
          expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
          expect(result[0]?.submatches[0]?.text).toBe("needle")
        }),
      ),
    windowsTestTimeout(30_000),
  )
})

describe("FileSystemSearch", () => {
  it.live.serial("waits for the initial file index before serving a search", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const ripgrep = Layer.succeed(
          Ripgrep.Service,
          Ripgrep.Service.of({
            find: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                if (input.onEntry) {
                  yield* input.onEntry(
                    Entry.make({
                      path: RelativePath.make("hello.txt"),
                      type: "file",
                    }),
                  )
                }
                return []
              }),
            glob: () => Effect.succeed([]),
            grep: () => Effect.succeed([]),
          }),
        )
        const locationLayer = Layer.succeed(
          Location.Service,
          Location.Service.of(location(Location.Ref.make({ directory }))),
        )
        const layer = FileSystemSearch.ripgrepLayer.pipe(
          Layer.provide(Layer.mergeAll(FSUtil.defaultLayer, ripgrep, locationLayer)),
        )

        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          yield* Deferred.await(started)
          const completed = yield* Deferred.make<readonly Entry[]>()
          const pending = yield* search.find(FileSystem.FindInput.make({ query: "hello", type: "file" })).pipe(
            Effect.tap((result) => Deferred.succeed(completed, result)),
            Effect.forkScoped,
          )
          yield* Effect.yieldNow
          expect(yield* Deferred.await(completed).pipe(Effect.timeoutOption("10 millis"))).toEqual(Option.none())

          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(pending)).toEqual([
            Entry.make({
              path: RelativePath.make("hello.txt"),
              type: "file",
            }),
          ])
        }).pipe(Effect.provide(layer))
      }),
    ),
  )
})
