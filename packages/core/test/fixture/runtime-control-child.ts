import assert from "node:assert/strict"
import { fstatSync } from "node:fs"
import { RuntimeControl } from "@mongolgpt/core/runtime-control"

const client = RuntimeControl.inherit({ readFD: 3, writeFD: 4 })
await client.register({ epoch: 1, writerID: "writer.runtime-control" })
for (let count = 0; count < 10; count++) await client.publish()
client.close()
const deadline = performance.now() + 2000
for (;;) {
  const closed = [3, 4].every((fd) => {
    try {
      fstatSync(fd)
      return false
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "EBADF")
      return true
    }
  })
  if (closed) break
  assert.ok(performance.now() < deadline, "inherited descriptors did not close")
  await Bun.sleep(10)
}
console.log("CONTROL_CLOSED")
