import { expect, spyOn, test } from "bun:test"
import { Terminal } from "bun-pty/src/terminal"
import { spawn } from "../../src/pty/pty.bun"

test.skipIf(process.platform === "win32")(
  "PTY spawn returns before the first native read can emit events",
  async () => {
    const prototype = Terminal.prototype as unknown as { _startReadLoop(): Promise<void> }
    const read = prototype._startReadLoop
    let constructing = true
    let earlyReads = 0
    const observer = spyOn(prototype, "_startReadLoop").mockImplementation(function (this: typeof prototype) {
      if (constructing) earlyReads++
      return read.call(this)
    })
    let child: ReturnType<typeof spawn> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      child = spawn("/usr/bin/env", ["sh", "-c", "exit 3"], {
        name: "xterm-256color",
        cwd: "/tmp",
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
      })
      constructing = false
      const exited = Promise.withResolvers<number>()
      const listener = child.onExit(({ exitCode }) => exited.resolve(exitCode))
      try {
        expect(earlyReads).toBe(0)
        timeout = setTimeout(() => exited.reject(new Error("PTY exit was not delivered")), 2000)
        expect(await exited.promise).toBe(3)
        expect(observer).toHaveBeenCalledTimes(1)
      } finally {
        listener.dispose()
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      observer.mockRestore()
      try {
        child?.kill()
      } catch {}
    }
  },
)
