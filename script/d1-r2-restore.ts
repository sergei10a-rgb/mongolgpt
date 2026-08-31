#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Resource } from "sst"
import {
  buildD1R2RestoreChildEnvironment,
  executeD1R2Restore,
  planD1R2Restore,
  type D1R2RestorePlan,
  type D1R2RestoreReceipt,
  type MaterializedD1R2Backup,
} from "@mongolgpt/script/d1-r2-restore"

const args = process.argv.slice(2)
const backupKey = option("--backup-key")
const operationId = option("--operation-id")
const execute = args.includes("--execute")
const receiptPath = option("--receipt")
if (!backupKey) fail("D1 R2 restore-д --backup-key <key> заавал өгнө.")
if (!operationId) fail("D1 R2 restore-д --operation-id <id> заавал өгнө.")
if (execute && !receiptPath) fail("D1 R2 restore execute үед --receipt <path> заавал өгнө.")

const app = linkedResource("App")
const database = linkedResource("Database")
const backups = linkedResource("D1Backups")
const stage = linkedString(app, "stage")
if (stage !== "dev" && stage !== "production") fail("D1 R2 restore зөвхөн dev эсвэл production орчинд ажиллана.")
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const apiToken = process.env.D1_R2_RESTORE_API_TOKEN
if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID тохируулаагүй байна.")
if (!apiToken) fail("D1_R2_RESTORE_API_TOKEN тохируулаагүй байна.")

const config = {
  accountId,
  sourceDatabaseId: linkedString(database, "databaseId"),
  backupBucket: linkedString(backups, "name"),
  apiToken,
  stage,
  operationId,
} as const

if (!execute) {
  const plan = await planD1R2Restore(config, backupKey)
  console.log("D1 R2 restore төлөвлөгөө бэлэн боллоо.", plan)
  process.exit(0)
}

const confirmation = process.env.MONGOLGPT_D1_R2_RESTORE_CONFIRMATION
if (!confirmation) fail("MONGOLGPT_D1_R2_RESTORE_CONFIRMATION дутуу байна.")
const absoluteReceipt = path.resolve(receiptPath!)
const tempDirectory = process.env.RUNNER_TEMP ? path.resolve(process.env.RUNNER_TEMP) : path.dirname(absoluteReceipt)
const sqlPath = path.join(tempDirectory, `mongolgpt-d1-r2-restore-${operationId}.sql`)
const wranglerPath = path.join(tempDirectory, `mongolgpt-d1-r2-restore-${operationId}.wrangler.json`)
if (await exists(absoluteReceipt)) fail(`D1 R2 restore receipt аль хэдийн байна: ${absoluteReceipt}`)
await fs.mkdir(path.dirname(absoluteReceipt), { recursive: true })
let receiptContext: Record<string, unknown> = {
  version: 1,
  kind: "mongolgpt-d1-r2-restore",
  stage,
  operationId,
  backupKeySha256: createHash("sha256").update(backupKey).digest("hex"),
}
await writeReceipt({
  ...receiptContext,
  status: "started",
  startedAt: new Date().toISOString(),
})

try {
  const receipt = await executeD1R2Restore({
    config,
    backupKey,
    confirmation,
    options: {
      prepared: (plan) => writePreparedReceipt(plan),
      materialize: (response, manifest) => materialize(response, manifest.artifact.size, manifest.artifact.etag),
      restore: restoreWithWrangler,
    },
  })
  await writeReceipt({ ...receiptContext, status: "passed", receipt })
  console.log("D1 R2 restore recovery өгөгдлийн санд амжилттай дууслаа.", {
    stage: receipt.stage,
    recoveryDatabaseName: receipt.recoveryDatabaseName,
    backupCreatedAt: receipt.backupCreatedAt,
    verifiedTables: receipt.verifiedTables,
    integrityCheck: receipt.integrityCheck,
  })
} catch (error) {
  await writeReceipt({
    ...receiptContext,
    status: "failed",
    failedAt: new Date().toISOString(),
    error: safeError(error),
  })
  console.error(`D1 R2 restore амжилтгүй боллоо: ${safeError(error)}`)
  process.exit(1)
}

async function materialize(
  response: Response,
  expectedSize: number,
  expectedEtag: string,
): Promise<MaterializedD1R2Backup> {
  if (!response.body) throw new Error("D1 backup SQL stream дутуу байна.")
  await fs.rm(sqlPath, { force: true })
  const writer = Bun.file(sqlPath).writer()
  const reader = response.body.getReader()
  const hasher = new Bun.CryptoHasher("md5")
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (size > expectedSize - part.value.byteLength) throw new Error("D1 backup SQL manifest хэмжээнээс хэтэрлээ.")
      size += part.value.byteLength
      hasher.update(part.value)
      await writer.write(part.value)
    }
    await writer.end()
  } catch (error) {
    await writer.end().catch(() => undefined)
    await fs.rm(sqlPath, { force: true })
    throw error
  } finally {
    reader.releaseLock()
  }
  const md5 = hasher.digest("hex")
  if (md5 !== expectedEtag.trim().replace(/^W\//, "").replace(/^"|"$/g, "").toLowerCase()) {
    await fs.rm(sqlPath, { force: true })
    throw new Error("D1 backup SQL checksum manifest-тай зөрж байна.")
  }
  return { size, md5, cleanup: () => fs.rm(sqlPath, { force: true }) }
}

async function restoreWithWrangler(input: {
  accountId: string
  databaseId: string
  databaseName: string
  artifact: MaterializedD1R2Backup
  apiToken: string
}) {
  await Bun.write(
    wranglerPath,
    JSON.stringify(
      {
        name: "mongolgpt-d1-r2-restore",
        compatibility_date: "2026-07-15",
        d1_databases: [
          { binding: "RECOVERY_DATABASE", database_name: input.databaseName, database_id: input.databaseId },
        ],
      },
      null,
      2,
    ),
  )
  try {
    const child = Bun.spawn(
      [
        "bun",
        "--cwd",
        "packages/console/app",
        "wrangler",
        "d1",
        "execute",
        "RECOVERY_DATABASE",
        "--remote",
        "--yes",
        "--file",
        sqlPath,
        "--config",
        wranglerPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: buildD1R2RestoreChildEnvironment(process.env, input),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`Wrangler D1 import амжилтгүй боллоо: ${safeOutput(stderr || stdout, [input.apiToken])}`)
    }
  } finally {
    await fs.rm(wranglerPath, { force: true })
  }
}

async function writePreparedReceipt(plan: D1R2RestorePlan) {
  receiptContext = {
    ...receiptContext,
    backupKeySha256: plan.backupKeySha256,
    backupCreatedAt: plan.backupCreatedAt,
    backupSize: plan.backupSize,
    recoveryDatabaseName: plan.recoveryDatabaseName,
  }
  await writeReceipt({
    ...receiptContext,
    status: "prepared",
    preparedAt: new Date().toISOString(),
  })
}

async function writeReceipt(
  value:
    | Record<string, unknown>
    | { status: "passed"; receipt: D1R2RestoreReceipt }
    | { status: "failed"; failedAt: string; error: string },
) {
  await Bun.write(absoluteReceipt, JSON.stringify(value, null, 2))
}

async function exists(file: string) {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
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

function linkedString(resource: object, name: string) {
  const value = Reflect.get(resource, name)
  if (typeof value !== "string" || !value.trim()) fail(`SST resource-ийн ${name} утга дутуу байна.`)
  return value
}

function safeOutput(value: string, secrets: string[] = []) {
  const text = secrets
    .filter(Boolean)
    .reduce((output, secret) => output.replaceAll(secret, "[REDACTED]"), value)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
  return text.slice(0, 512) || "дэлгэрэнгүй мэдээлэлгүй"
}

function safeError(error: unknown) {
  return safeOutput(error instanceof Error ? error.message : "тодорхойгүй алдаа", [
    apiToken,
    backupKey,
    confirmation ?? "",
  ])
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
