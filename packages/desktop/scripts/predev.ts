import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.MONGOLGPT_CHANNEL ?? "dev"}`

await $`cd ../mongolgpt && bun script/build-node.ts`
