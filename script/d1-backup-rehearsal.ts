#!/usr/bin/env bun

import path from "node:path"
import { Resource } from "sst"
import { executeD1BackupRehearsal } from "@mongolgpt/script/d1-backup-rehearsal"

const args = process.argv.slice(2)
const receiptPath = option("--receipt")
if (!receiptPath) fail("D1 нөөцлөлтийн сургуулилалтад --receipt <path> заавал өгнө.")

const app = linkedResource("App")
const workflow = linkedResource("D1BackupWorkflow")
const stage = linkedString(app, "stage")
if (stage !== "dev") fail("D1 нөөцлөлтийн сургуулилалт зөвхөн dev орчинд ажиллана.")
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const runId = process.env.GITHUB_RUN_ID
if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID тохируулаагүй байна.")
if (!apiToken) fail("CLOUDFLARE_API_TOKEN тохируулаагүй байна.")
if (!runId) fail("GITHUB_RUN_ID тохируулаагүй байна.")

const absoluteReceipt = path.resolve(receiptPath)
if (await Bun.file(absoluteReceipt).exists())
  fail(`D1 нөөцлөлтийн сургуулилалтын receipt аль хэдийн байна: ${absoluteReceipt}`)
await Bun.write(
  absoluteReceipt,
  JSON.stringify(
    {
      version: 1,
      kind: "mongolgpt-d1-backup-rehearsal",
      status: "started",
      runId,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
)

try {
  const receipt = await executeD1BackupRehearsal({
    accountId,
    workflowName: linkedString(workflow, "workflowName"),
    apiToken,
    stage,
    runId,
  })
  await Bun.write(absoluteReceipt, JSON.stringify({ ...receipt, status: "passed" }, null, 2))
  console.log("Dev D1 нөөцлөлтийн rehearsal амжилттай дууслаа.", {
    workflowName: receipt.workflowName,
    instanceId: receipt.instanceId,
    completedAt: receipt.completedAt,
  })
} catch (error) {
  await Bun.write(
    absoluteReceipt,
    JSON.stringify(
      {
        version: 1,
        kind: "mongolgpt-d1-backup-rehearsal",
        status: "failed",
        runId,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Тодорхойгүй алдаа",
      },
      null,
      2,
    ),
  )
  console.error(
    `Dev D1 нөөцлөлтийн rehearsal амжилтгүй боллоо: ${error instanceof Error ? error.message : "Тодорхойгүй алдаа"}`,
  )
  process.exit(1)
}

function option(name: string) {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

function linkedResource(name: string) {
  const value = Reflect.get(Resource, name)
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`SST ${name} resource дутуу байна.`)
  return value
}

function linkedString(resource: object, key: string) {
  const value = Reflect.get(resource, key)
  if (typeof value !== "string" || !value.trim()) fail(`SST resource-ийн ${key} утга дутуу байна.`)
  return value.trim()
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
