import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { RuntimeContainer } from "../src/runtime-container"
import { RuntimeContainerControl } from "../src/runtime-container-control"
import { tmpdir } from "./fixture/tmpdir"

describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("container lifecycle ordering", () => {
  for (const success of [true, false]) {
    test(`waits for the supervisor receipt before signalling the SDK, saved=${success}`, async () => {
      await using temp = await tmpdir()
      const directory = join(temp.path, "control")
      const release = Promise.withResolvers<void>()
      const drained = Promise.withResolvers<void>()
      let receipt: Promise<void> | undefined
      const running = RuntimeContainer.run({ directory, ...sdk(temp.path) })
      const settled = running.then(
        (code) => code,
        () => -1,
      )
      try {
        await waitFor(() => Bun.file(join(temp.path, "sdk-ready")).exists())
        const client = await RuntimeContainerControl.join({
          directory,
          onDrain() {
            drained.resolve()
            receipt = release.promise.then(() => client.complete(success))
            void receipt.catch(() => {})
          },
          onDisconnect() {},
        })
        process.emit("SIGTERM", "SIGTERM")
        process.emit("SIGINT", "SIGINT")
        await drained.promise
        expect(await Bun.file(join(temp.path, "sdk-stop")).exists()).toBe(false)
        await expect(RuntimeContainerControl.join({ directory, onDrain() {}, onDisconnect() {} })).rejects.toThrow()
        expect(await Promise.race([settled, setTimeout(25).then(() => "pending")])).toBe("pending")
        release.resolve()
        expect(await settled).toBe(success ? 0 : 1)
        await receipt?.catch(() => {})
        expect(await Bun.file(join(temp.path, "sdk-stop")).exists()).toBe(true)
        expect(await readFile(join(temp.path, "sdk-env"), "utf8")).toBe("absent")
      } finally {
        release.resolve()
        process.emit("SIGTERM", "SIGTERM")
        await settled
      }
    }, 15_000)
  }

  test("unexpected SDK exit fences the connected native supervisor", async () => {
    await using temp = await tmpdir()
    const directory = join(temp.path, "control")
    const disconnected = Promise.withResolvers<void>()
    const running = RuntimeContainer.run({ directory, ...sdk(temp.path) })
    try {
      await waitFor(() => Bun.file(join(temp.path, "sdk-ready")).exists())
      await RuntimeContainerControl.join({
        directory,
        onDrain() {
          throw new Error("Fatal SDK exit must not request a snapshot")
        },
        onDisconnect: () => disconnected.resolve(),
      })
      await writeFile(join(temp.path, "sdk-crash"), "crash")
      expect(await running).toBe(1)
      await disconnected.promise
      expect(await Bun.file(join(temp.path, "sdk-stop")).exists()).toBe(false)
    } finally {
      process.emit("SIGTERM", "SIGTERM")
      await running.catch(() => {})
    }
  }, 15_000)

  test("SDK exit during a pending final receipt fences the supervisor immediately", async () => {
    await using temp = await tmpdir()
    const directory = join(temp.path, "control")
    const drained = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    const running = RuntimeContainer.run({ directory, ...sdk(temp.path), timeoutMs: 10_000 })
    try {
      await waitFor(() => Bun.file(join(temp.path, "sdk-ready")).exists())
      await RuntimeContainerControl.join({
        directory,
        onDrain: () => drained.resolve(),
        onDisconnect: () => disconnected.resolve(),
      })
      process.emit("SIGTERM", "SIGTERM")
      await drained.promise
      await writeFile(join(temp.path, "sdk-crash"), "crash")
      expect(await running).toBe(1)
      await disconnected.promise
      expect(await Bun.file(join(temp.path, "sdk-stop")).exists()).toBe(false)
    } finally {
      process.emit("SIGTERM", "SIGTERM")
      await running.catch(() => {})
    }
  }, 5_000)

  test("a stuck SDK is force-closed only after the drain and its shutdown deadline", async () => {
    await using temp = await tmpdir()
    const running = RuntimeContainer.run({
      directory: join(temp.path, "control"),
      ...sdk(temp.path, true),
      sdkStopTimeoutMs: 30,
    })
    try {
      await waitFor(() => Bun.file(join(temp.path, "sdk-ready")).exists())
      process.emit("SIGTERM", "SIGTERM")
      expect(await running).toBe(1)
      expect(await Bun.file(join(temp.path, "sdk-stop")).exists()).toBe(true)
    } finally {
      process.emit("SIGTERM", "SIGTERM")
      await running.catch(() => {})
    }
  }, 15_000)
})

function sdk(root: string, stuck = false) {
  return {
    executable: process.execPath,
    args: [
      "-e",
      `
      const { writeFileSync, existsSync } = require("node:fs");
      const root = ${JSON.stringify(root)};
      process.on("SIGTERM", () => {
        writeFileSync(root + "/sdk-stop", "stopped");
        if (!${stuck}) process.exit(0);
      });
      writeFileSync(root + "/sdk-env", process.env.MONGOLGPT_CONTAINER_ENTRYPOINT ?? "absent");
      writeFileSync(root + "/sdk-ready", "ready");
      setInterval(() => { if (existsSync(root + "/sdk-crash")) process.exit(7); }, 10);
    `,
    ],
    env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", MONGOLGPT_CONTAINER_ENTRYPOINT: "true" },
  }
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("SDK fixture did not become ready")
    await setTimeout(10)
  }
}
