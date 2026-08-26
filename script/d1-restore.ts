#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"
import { Resource } from "sst"
import {
  executeD1Restore,
  planD1Restore,
  type D1RestoreStage,
  type D1RestoreTarget,
} from "@mongolgpt/script/d1-restore"

const args = process.argv.slice(2)
const execute = args.includes("--execute")
const bookmark = option("--bookmark")
const timestamp = option("--timestamp")
const confirmation = option("--confirmation") ?? process.env.MONGOLGPT_D1_RESTORE_CONFIRMATION ?? ""
const receiptPath = option("--receipt")

if (Boolean(bookmark) === Boolean(timestamp)) fail("--bookmark эсвэл --timestamp-ээс яг нэгийг заана.")

const resources = Resource as unknown as {
  App: { stage: string }
  Database: { databaseId: string }
  D1BackupApiToken: { value: string }
}
const stage = (process.env.MONGOLGPT_STAGE ?? resources.App.stage) as D1RestoreStage
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const apiToken = process.env.D1_BACKUP_API_TOKEN ?? resources.D1BackupApiToken.value
if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID тохируулаагүй байна.")

const config = { accountId, databaseId: resources.Database.databaseId, apiToken, stage }
const target: D1RestoreTarget = bookmark
  ? { kind: "bookmark", value: bookmark }
  : { kind: "timestamp", value: timestamp! }

if (!execute) {
  const plan = await planD1Restore(config, target)
  console.log(JSON.stringify({ status: "planned", ...plan }, null, 2))
  console.log(
    "\nЭнэ команд өгөгдөл өөрчлөөгүй. Сэргээхийн тулд --execute, --receipt болон дээрх confirmation-ийг өгнө.",
  )
  process.exit(0)
}

if (!receiptPath) fail("Сэргээх үед --receipt <path> заавал өгнө.")
const absoluteReceipt = path.resolve(receiptPath)
if (fs.existsSync(absoluteReceipt)) fail(`Receipt файл аль хэдийн байна: ${absoluteReceipt}`)
fs.mkdirSync(path.dirname(absoluteReceipt), { recursive: true })

const receipt = await executeD1Restore({
  config,
  target,
  confirmation,
  prepared: async (plan) => {
    await Bun.write(
      absoluteReceipt,
      JSON.stringify({ status: "prepared", preparedAt: new Date().toISOString(), ...plan }, null, 2),
    )
  },
})
await Bun.write(absoluteReceipt, JSON.stringify({ status: "restored", ...receipt }, null, 2))
console.log(JSON.stringify({ status: "restored", receipt: absoluteReceipt, ...receipt }, null, 2))

function option(name: string) {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
