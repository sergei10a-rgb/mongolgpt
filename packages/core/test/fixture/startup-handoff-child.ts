import assert from "node:assert/strict"
import { fstatSync, writeSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"

const root = process.argv[2]
const reject = process.argv[3] === "reject"
const writer = process.argv[3] === "writer"
assert.equal(process.getuid!(), 10001)
if (reject) {
  await assert.rejects(CloudStartup.prepare({ root }))
  assert.throws(() => CloudStartup.baseline())
  console.log("STARTUP_HANDOFF_REJECTED")
} else {
  assert.equal(fstatSync(4).uid, 0)
  assert.equal(fstatSync(4).nlink, 0)
  assert.throws(() => writeSync(4, Buffer.from("tampered")))
  await CloudStartup.prepare({ root })
  assert.equal(CloudStartup.supervised(), true)
  assert.equal(process.env.MONGOLGPT_RUNTIME_PREPARED_FD, undefined)
  if (writer) assert.ok(CloudStartup.baseline())
  else assert.equal(CloudStartup.baseline(), undefined)
  await writeFile(join(root, "child-owned.txt"), "restored then isolated")
  await CloudStartup.prepare({ root })
  assert.equal(CloudStartup.supervised(), true)
  console.log("STARTUP_HANDOFF_READY")
  if (writer) {
    const { spawn } = await import("node:child_process")
    spawn(
      process.execPath,
      [
        "-e",
        `
      const fs=require("node:fs");let count=0;
      setInterval(()=>fs.writeFileSync(${JSON.stringify(join(root, "project/counter.txt"))},String(++count)),5);
    `,
      ],
      { env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" }, detached: true, stdio: "ignore" },
    ).unref()
    setInterval(() => {}, 1000)
  }
}
