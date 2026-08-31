import { AdminDeploymentDiffError, inspectAdminDeploymentDiff } from "@mongolgpt/script/sst-admin-diff"

const path = process.argv[2]
if (!path) {
  console.error("SST admin diff JSON файлын зам дутуу байна.")
  process.exit(1)
}

try {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new AdminDeploymentDiffError("SST admin diff JSON файл олдсонгүй.")
  if (file.size > 16 * 1024 * 1024) throw new AdminDeploymentDiffError("SST admin diff JSON файл хэт том байна.")
  const summary = inspectAdminDeploymentDiff(await file.json())
  const operations = Object.entries(summary.operations)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([operation, count]) => `${operation}=${count}`)
    .join(", ")
  console.log(
    `Admin-only SST diff зөвшөөрөгдсөн хүрээнд байна: ${summary.changes} өөрчлөлт${operations ? ` (${operations})` : ""}.`,
  )
} catch (error) {
  if (error instanceof AdminDeploymentDiffError || error instanceof SyntaxError) {
    console.error(
      `Admin-only SST diff баталгаажуулалт амжилтгүй боллоо: ${
        error instanceof SyntaxError ? "JSON файл хүчинтэй биш байна." : error.message
      }`,
    )
    process.exit(1)
  }
  throw error
}
