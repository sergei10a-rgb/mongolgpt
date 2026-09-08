import { writeFile } from "node:fs/promises"
import { RuntimeLock } from "@mongolgpt/core/runtime-lock"

const root = process.argv[2]
const launcher = process.argv[3]
const ready = process.argv[4]

if (!root || !launcher || !ready) throw new Error("runtime-lock-child requires root, launcher, and ready path")

await using lock = await RuntimeLock.acquire({ root, launcher })
await writeFile(ready, JSON.stringify({ root: lock.root, directory: lock.directory }))
setInterval(() => Bun.gc(true), 10)
await new Promise(() => {})
