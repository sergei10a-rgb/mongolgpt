import { expect, test } from "bun:test"
import { PassThrough, Writable } from "node:stream"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"
import { RuntimeControl } from "@mongolgpt/core/runtime-control"
import { captureNativeStderr } from "../../src/cli/native-startup-diagnostic"

for (const [message, code] of [
  ["EACCES: private-user@example.test /private/path", "EACCES"],
  ["ERR_DLOPEN_FAILED: private native library", "ERR_DLOPEN_FAILED"],
  ["MongolGPT workspace isolation failed.", "WorkspaceIsolationError"],
  [new StartupHandoff.HandoffError().message, "StartupHandoffError"],
  [new RuntimeControl.RuntimeControlError().message, "RuntimeControlError"],
  ["TypeError: private detail", "TypeError"],
  ["prefixEACCESsuffix private password", "unknown"],
  ["private token and unrecognized failure", "unknown"],
] as const) {
  test(`retains only bounded classification ${code}`, async () => {
    const source = new PassThrough()
    const forwarded: Buffer[] = []
    const destination = new Writable({
      write(chunk, _encoding, done) {
        forwarded.push(chunk)
        done()
      },
    })
    const collect = captureNativeStderr(source, destination)
    const bytes = Buffer.from(message)
    source.write(bytes.subarray(0, 3))
    source.end(bytes.subarray(3))
    expect(await collect()).toBe(code)
    expect(await collect()).toBe(code)
    expect(Buffer.concat(forwarded).toString()).toBe(message)
    expect(destination.writableEnded).toBe(false)
    expect(source.listenerCount("data")).toBe(0)
    expect(source.destroyed).toBe(true)
  })
}

test("ignores text past 4 KiB and bounds collection when stderr does not close", async () => {
  const source = new PassThrough()
  const destination = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const collect = captureNativeStderr(source, destination)
  source.write(Buffer.alloc(4096, 32))
  source.write("EACCES: private-after-bound")
  const start = performance.now()
  expect(await collect()).toBe("unknown")
  expect(performance.now() - start).toBeLessThan(1500)
  expect(source.destroyed).toBe(true)
  expect(destination.writableEnded).toBe(false)
})

test("missing and errored stderr cannot prevent cleanup", async () => {
  expect(await captureNativeStderr(null)()).toBe("unknown")
  const source = new PassThrough()
  const destination = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const collect = captureNativeStderr(source, destination)
  source.destroy(new Error("private stream error"))
  await new Promise<void>((resolve) => source.once("close", resolve))
  expect(await collect()).toBe("unknown")
})
