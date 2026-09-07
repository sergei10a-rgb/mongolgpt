import type { Argv } from "yargs"
import type { DatabaseBackup } from "@mongolgpt/core/database/backup"
import { spawn } from "child_process"
import { Database } from "@mongolgpt/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { lstat, open } from "node:fs/promises"
import { cmd } from "./cmd"
import { CliError, effectCmd } from "../effect-cmd"

const BackupPurpose =
  "SQLite логик мета өгөгдөл, түүх, итгэмжлэлийн шифрлэсэн бүрэн нөөц. Далд ROWID өөрчлөгдөж болох ч ил тод хадгалсан ID хэвээр үлдэнэ. Төслийн файл, тохиргоо, Git сан, R2 объект болон D1 рүү шилжүүлэлт хамрагдахгүй."
const BackupWarning =
  "Анхаар: зөвхөн хувийн хавтас ашиглана уу. Windows дээр түр хавтсыг зөвхөн одоогийн хэрэглэгч болон SYSTEM-д нээлттэй болгоно. Сэргээсэн SQLite нь итгэмжлэлийн нууцыг ил текстээр агуулна. Эдгээр файлыг нийтэд байршуулах эсвэл Git-д бүртгэхгүй."
const BackupHelp = [BackupPurpose, BackupWarning].join("\n")

function cliFail(message: string): never {
  throw new CliError({ message })
}

function requiredArg(value: string | undefined, name: string) {
  if (value) return value
  cliFail(`Заавал өгөх аргумент дутуу: ${name}`)
}

function stripFinalNewline(input: string) {
  if (input.endsWith("\r\n")) return input.slice(0, -2)
  if (input.endsWith("\n")) return input.slice(0, -1)
  return input
}

async function readKeyFile(keyFile: string): Promise<Uint8Array> {
  let linkInfo: Awaited<ReturnType<typeof lstat>>
  try {
    linkInfo = await lstat(keyFile)
  } catch {
    cliFail("Шифрлэлтийн түлхүүрийн файл олдсонгүй эсвэл уншиж чадсангүй.")
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    cliFail("Шифрлэлтийн түлхүүрийн зам энгийн файл байх ёстой.")
  }
  let file
  try {
    file = await open(keyFile, "r")
  } catch {
    cliFail("Шифрлэлтийн түлхүүрийн файл олдсонгүй эсвэл уншиж чадсангүй.")
  }
  try {
    const info = await file.stat()
    if (!info.isFile()) {
      cliFail("Шифрлэлтийн түлхүүрийн зам энгийн файл байх ёстой.")
    }
    if (info.size > 256) {
      cliFail("Шифрлэлтийн түлхүүрийн файл хэт том байна.")
    }
    const buffer = Buffer.alloc(257)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 256) {
      cliFail("Шифрлэлтийн түлхүүрийн файл хэт том байна.")
    }
    if (bytesRead !== info.size) {
      cliFail("Шифрлэлтийн түлхүүрийн файлыг бүрэн уншиж чадсангүй.")
    }
    const text = stripFinalNewline(buffer.subarray(0, bytesRead).toString("utf8"))
    if (!/^[0-9a-fA-F]{64}$/.test(text)) {
      cliFail("Шифрлэлтийн түлхүүрийн файл 64 тэмдэгт hex түлхүүр агуулсан байх ёстой.")
    }
    const key = Uint8Array.from(Buffer.from(text, "hex"))
    buffer.fill(0)
    return key
  } finally {
    await file.close()
  }
}

function backupError(error: { message?: unknown }) {
  return new CliError({
    message:
      typeof error.message === "string"
        ? error.message
        : "Нөөцлөх эсвэл сэргээх үйлдэл амжилтгүй боллоо. Эх өгөгдлийн санг өөрчлөөгүй.",
  })
}

function printReport(verb: "backup" | "restore", report: DatabaseBackup.Report) {
  console.log(verb === "backup" ? "SQLite нөөц амжилттай үүслээ." : "SQLite өгөгдлийн сан амжилттай сэргээгдлээ.")
  console.log(BackupPurpose)
  console.log(BackupWarning)
  console.log(`Формат: ${report.format}`)
  console.log(`Хэмжээ: ${report.bytes} байт`)
  console.log(`SHA-256: ${report.sha256}`)
  console.log(`Схем SHA-256: ${report.schemaSha256}`)
  console.log("Хүснэгтүүд:")
  if (report.tables.length === 0) {
    console.log("  (байхгүй)")
    return
  }
  for (const table of report.tables) {
    console.log(`  ${JSON.stringify(table.name)}: ${table.rows} мөр`)
  }
}

async function runBackup(input: { source: string; destination: string; keyFile: string }) {
  const key = await readKeyFile(input.keyFile)
  try {
    const { DatabaseBackup } = await import("@mongolgpt/core/database/backup")
    const report = await Effect.runPromise(
      DatabaseBackup.create({ source: input.source, destination: input.destination, key }).pipe(
        Effect.mapError(backupError),
      ),
    )
    printReport("backup", report)
  } finally {
    key.fill(0)
  }
}

async function runRestore(input: { source: string; destination: string; keyFile: string }) {
  const key = await readKeyFile(input.keyFile)
  try {
    const { DatabaseBackup } = await import("@mongolgpt/core/database/backup")
    const report = await Effect.runPromise(
      DatabaseBackup.restore({ source: input.source, destination: input.destination, key }).pipe(
        Effect.mapError(backupError),
      ),
    )
    printReport("restore", report)
  } finally {
    key.fill(0)
  }
}

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "sqlite3-ийн харилцан үйлдэлт бүрхүүл нээх эсвэл асуулга ажиллуулах",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "ажиллуулах SQL асуулга",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "гаралтын формат",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "өгөгдлийн сангийн замыг хэвлэх",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const BackupCommand = cmd<
  {},
  {
    destination?: string
    source?: string
    keyFile?: string
  }
>({
  command: "backup <destination>",
  describe: "SQLite өгөгдлийн сангийн шифрлэсэн бүрэн нөөц үүсгэх",
  builder: (yargs) =>
    yargs
      .positional("destination", {
        type: "string",
        describe: "шинээр үүсгэх шифрлэсэн нөөц файлын зам",
      })
      .option("source", {
        type: "string",
        demandOption: true,
        describe: "нөөцлөх одоо байгаа SQLite өгөгдлийн сангийн зам (заавал; анхдагч DB-г автоматаар нээхгүй)",
      })
      .option("key-file", {
        type: "string",
        demandOption: true,
        describe: "64 hex тэмдэгттэй 32 байт шифрлэлтийн түлхүүр агуулсан энгийн файл",
      })
      .epilogue(BackupHelp),
  async handler(args) {
    await runBackup({
      source: requiredArg(args.source, "source"),
      destination: requiredArg(args.destination, "destination"),
      keyFile: requiredArg(args.keyFile, "key-file"),
    })
  },
})

const RestoreCommand = cmd<
  {},
  {
    source?: string
    destination?: string
    keyFile?: string
  }
>({
  command: "restore <source> <destination>",
  describe: "шифрлэсэн SQLite нөөцөөс шинэ өгөгдлийн сан сэргээх",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "унших шифрлэсэн нөөц файлын зам",
      })
      .positional("destination", {
        type: "string",
        describe: "шинээр үүсгэх сэргээгдсэн SQLite өгөгдлийн сангийн зам",
      })
      .option("key-file", {
        type: "string",
        demandOption: true,
        describe: "64 hex тэмдэгттэй 32 байт шифрлэлтийн түлхүүр агуулсан энгийн файл",
      })
      .epilogue(BackupHelp),
  async handler(args) {
    await runRestore({
      source: requiredArg(args.source, "source"),
      destination: requiredArg(args.destination, "destination"),
      keyFile: requiredArg(args.keyFile, "key-file"),
    })
  },
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "өгөгдлийн сангийн хэрэгслүүд",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(BackupCommand)
      .command(RestoreCommand)
      .demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
