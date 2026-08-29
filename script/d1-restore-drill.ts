#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"
import { Resource } from "sst"
import {
  buildD1RestoreDrillChildEnvironment,
  executeD1RestoreDrill,
  type D1RestoreDrillReceipt,
  type MaterializedD1Backup,
} from "@mongolgpt/script/d1-restore-drill"

const args = process.argv.slice(2)
const receiptPath = option("--receipt")
if (!receiptPath) fail("D1 restore drill-д --receipt <path> заавал өгнө.")

const app = linkedResource("App")
const database = linkedResource("Database")
const backups = linkedResource("D1Backups")
const stage = linkedString(app, "stage")
if (stage !== "dev") fail("Автомат D1 сэргээх туршилт зөвхөн dev орчинд ажиллана.")
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
const apiToken = process.env.D1_RESTORE_DRILL_API_TOKEN
const runId = process.env.GITHUB_RUN_ID
if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID тохируулаагүй байна.")
if (!apiToken) fail("D1_RESTORE_DRILL_API_TOKEN тохируулаагүй байна.")
if (!runId) fail("GITHUB_RUN_ID тохируулаагүй байна.")

const absoluteReceipt = path.resolve(receiptPath)
const tempDirectory = process.env.RUNNER_TEMP ? path.resolve(process.env.RUNNER_TEMP) : path.dirname(absoluteReceipt)
const sqlPath = path.join(tempDirectory, `mongolgpt-d1-restore-drill-${runId}.sql`)
const wranglerPath = path.join(tempDirectory, `mongolgpt-d1-restore-drill-${runId}.wrangler.json`)
if (await exists(absoluteReceipt)) fail(`Restore drill receipt аль хэдийн байна: ${absoluteReceipt}`)
await fs.mkdir(path.dirname(absoluteReceipt), { recursive: true })
await Bun.write(
  absoluteReceipt,
  JSON.stringify({ version: 1, kind: "mongolgpt-d1-restore-drill", status: "started", runId, startedAt: new Date().toISOString() }, null, 2),
)

try {
  const receipt = await executeD1RestoreDrill(
    {
      accountId,
      sourceDatabaseId: linkedString(database, "databaseId"),
      backupBucket: linkedString(backups, "name"),
      apiToken,
      stage,
      runId,
    },
    {
      materialize: (response, manifest) => materialize(response, manifest.artifact.size),
      restore: restoreWithWrangler,
    },
  )
  await writeReceipt({ status: "passed", receipt })
  console.log("Dev D1 сэргээх туршилт амжилттай дууслаа.", {
    backupCreatedAt: receipt.backupCreatedAt,
    verifiedTables: receipt.verifiedTables,
  })
} catch (error) {
  await writeReceipt({ status: "failed", failedAt: new Date().toISOString(), error: safeError(error) })
  console.error(`Dev D1 сэргээх туршилт амжилтгүй боллоо: ${safeError(error)}`)
  process.exit(1)
}

async function materialize(response: Response, expectedSize: number): Promise<MaterializedD1Backup> {
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
  return {
    size,
    md5: hasher.digest("hex"),
    body: () => Bun.file(sqlPath),
    cleanup: () => fs.rm(sqlPath, { force: true }),
  }
}

async function restoreWithWrangler(input: {
  accountId: string
  databaseId: string
  databaseName: string
  artifact: MaterializedD1Backup
  apiToken: string
}) {
  await Bun.write(
    wranglerPath,
    JSON.stringify(
      {
        name: "mongolgpt-d1-restore-drill",
        compatibility_date: "2026-07-15",
        d1_databases: [
          { binding: "RESTORE_DRILL", database_name: input.databaseName, database_id: input.databaseId },
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
        "RESTORE_DRILL",
        "--remote",
        "--yes",
        "--file",
        sqlPath,
        "--config",
        wranglerPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: buildD1RestoreDrillChildEnvironment(process.env, input),
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

async function writeReceipt(value: { status: "passed"; receipt: D1RestoreDrillReceipt } | { status: "failed"; failedAt: string; error: string }) {
  await Bun.write(absoluteReceipt, JSON.stringify({ version: 1, kind: "mongolgpt-d1-restore-drill", ...value }, null, 2))
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
    .reduce((output, secret) => output.replaceAll(secret, "[REDACTED]"), value)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
  return text.slice(0, 512) || "дэлгэрэнгүй мэдээлэлгүй"
}

function safeError(error: unknown) {
  return safeOutput(error instanceof Error ? error.message : "тодорхойгүй алдаа", apiToken ? [apiToken] : [])
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
