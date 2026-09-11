import { readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import config from "../wrangler.storage.dev.json"

const root = fileURLToPath(new URL("..", import.meta.url))
const accountID = config.account_id
const database = config.d1_databases[0]
const bucket = config.r2_buckets[0]

export function storagePreparationContext(env: NodeJS.ProcessEnv) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.MONGOLGPT_STORAGE_CONFIRMATION !== "PREPARE DEV RUNTIME STORAGE" ||
    env.CLOUDFLARE_ACCOUNT_ID !== accountID ||
    !env.CLOUDFLARE_API_TOKEN?.trim() ||
    !isAbsolute(env.RUNNER_TEMP ?? "")
  )
    throw new Error("Dev runtime хадгалалт бэлтгэх орчин эсвэл баталгаажуулалт буруу байна.")
  return { accountID, databaseID: database.database_id, bucketName: bucket.bucket_name }
}

export function storageMigrationCommand(operation: "apply" | "verify", executable = process.execPath) {
  const base = [executable, "x", "--no-install", "wrangler", "d1"]
  const options = ["HISTORY", "--remote", "--config=wrangler.storage.dev.json"]
  if (operation === "apply") return [...base, "migrations", "apply", ...options]
  return [...base, "execute", ...options, "--command=SELECT name FROM d1_migrations ORDER BY name", "--json"]
}

export function verifyStorageMigrations(input: unknown, expected: string[]) {
  if (!Array.isArray(input) || input.length !== 1) throw new Error("Хадгалалтын схемийн хариу буруу байна.")
  const result = input[0]
  if (result?.success !== true || !Array.isArray(result.results))
    throw new Error("Хадгалалтын схемийн шалгалт амжилтгүй боллоо.")
  const names = result.results.map((row: unknown) => {
    if (!row || typeof row !== "object" || !("name" in row) || typeof row.name !== "string")
      throw new Error("Хадгалалтын схемийн нэр буруу байна.")
    return row.name
  })
  if (expected.length === 0 || JSON.stringify(names) !== JSON.stringify([...expected].sort()))
    throw new Error("Серверийн хадгалалтын схем одоогийн кодтой тохирохгүй байна.")
  return names
}

export async function verifyStorageIdentity(
  token: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  // Only metadata reads against these exact new resources, never console data.
  for (const [path, name, id] of [
    [`d1/database/${database.database_id}`, database.database_name, database.database_id],
    [`r2/buckets/${bucket.bucket_name}`, bucket.bucket_name, undefined],
  ]) {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${accountID}/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
      void response.body?.cancel().catch(() => {})
      throw new Error("Хадгалалтын нөөцийн эрх эсвэл хариу буруу байна.")
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Хадгалалтын нөөцийн хариу хоосон байна.")
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 32_768) throw new Error("Хадгалалтын нөөцийн хариу хэт том байна.")
        chunks.push(chunk.value)
      }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (value?.success !== true || value.result?.name !== name || (id && value.result?.uuid !== id))
      throw new Error("Шилжүүлэлтэд зориулсан хадгалалтын нөөцийн нэр эсвэл ID зөрлөө.")
  }
}

async function run() {
  if (process.argv.length !== 2) throw new Error("Хадгалалт бэлтгэх команд нэмэлт аргумент авахгүй.")
  const identity = storagePreparationContext(process.env)
  console.log("STORAGE_PREPARATION_PHASE identity")
  await verifyStorageIdentity(process.env.CLOUDFLARE_API_TOKEN!)
  const expected = (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort()
  const execute = async (operation: "apply" | "verify") => {
    const child = Bun.spawn(storageMigrationCommand(operation), {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000)
    try {
      const output = await new Response(child.stdout).text()
      if ((await child.exited) !== 0) throw new Error("Dev хадгалалтын схем бэлтгэх команд амжилтгүй боллоо.")
      return output
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }
  console.log("STORAGE_PREPARATION_PHASE migrations_apply")
  await execute("apply")
  console.log("STORAGE_PREPARATION_PHASE migrations_verify")
  const migrations = verifyStorageMigrations(JSON.parse(await execute("verify")), expected)
  const receipt = { stage: "dev", ...identity, migrations, workerDeployed: false, historyActivated: false }
  await Bun.write(join(process.env.RUNNER_TEMP!, "runtime-storage-receipt.json"), JSON.stringify(receipt, null, 2))
  console.log("STORAGE_PREPARATION_PHASE complete")
  console.log("Dev runtime хадгалалтын схем бэлэн. Worker болон хуучин өгөгдөл өөрчлөгдөөгүй.")
}

if (import.meta.main)
  run().catch(() => {
    console.error("Dev runtime хадгалалт бэлтгэж чадсангүй. Нууц утга, API хариу болон өгөгдөл хэвлэгдээгүй.")
    process.exitCode = 1
  })
