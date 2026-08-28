#!/usr/bin/env bun

import { repairCloudflareQueueProviderState } from "@mongolgpt/script/cloudflare-state-repair"

if (process.env.MONGOLGPT_REPAIR_CLOUDFLARE_QUEUE_PROVIDER !== "true") {
  fail("Cloudflare provider state repair зөвхөн баталгаажсан migration workflow-д ажиллана.")
}

const [path, ...extra] = process.argv.slice(2)
if (!path || extra.length > 0) fail("SST state файлын зам яг нэг байх ёстой.")

const file = Bun.file(path)
if (!(await file.exists())) fail("SST state файл олдсонгүй.")
if (file.size > 64 * 1024 * 1024) fail("SST state файл зөвшөөрөгдөх хэмжээнээс хэтэрлээ.")

let state: unknown
try {
  state = JSON.parse(await file.text())
} catch {
  fail("SST state JSON уншигдсангүй.")
}

const result = repairCloudflareQueueProviderState(state)
if (result.changed) await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`)
console.log(result.changed ? "Cloudflare queue provider state засагдлаа." : "Cloudflare queue provider state аль хэдийн зөв байна.")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
