import { join } from "node:path"
import {
  inspectSstCommandErrorDiagnostics,
  inspectSstErrorDiagnostics,
} from "@mongolgpt/script/sst-error-diagnostics"

const root = process.argv[2]
if (!root) {
  console.error("SST Pulumi event log хавтасны зам дутуу байна.")
  process.exit(1)
}

const maximumFiles = 8
const maximumFileBytes = 16 * 1024 * 1024
const maximumTotalBytes = 32 * 1024 * 1024
const sensitiveName = /(credential|key|password|secret|token)/i
const secretValues = Object.entries(process.env).flatMap(([name, value]) =>
  sensitiveName.test(name) && value ? [value] : [],
)

let totalBytes = 0
let files = 0
const diagnostics = []
const glob = new Bun.Glob("**/eventlog.json")
for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
  if (files === maximumFiles) break
  const file = Bun.file(join(root, relative))
  if (file.size > maximumFileBytes || totalBytes + file.size > maximumTotalBytes) continue
  totalBytes += file.size
  files += 1
  diagnostics.push(...inspectSstErrorDiagnostics(await file.text(), secretValues))
}

for (const path of process.argv.slice(3, 7)) {
  const file = Bun.file(path)
  if (!(await file.exists())) continue
  if (file.size > maximumFileBytes || totalBytes + file.size > maximumTotalBytes) continue
  totalBytes += file.size
  diagnostics.push(...inspectSstCommandErrorDiagnostics(await file.text(), secretValues))
}

const unique = [
  ...new Map(diagnostics.map((diagnostic) => [`${diagnostic.resource ?? ""}\n${diagnostic.message}`, diagnostic])).values(),
].slice(0, 12)

if (!unique.length) {
  console.error("Pulumi preview амжилтгүй болсон ч аюулгүй error diagnostic event олдсонгүй.")
} else {
  console.error("Pulumi preview-ийн нууц утгагүй error diagnostics:")
  for (const diagnostic of unique) {
    console.error(`- ${diagnostic.resource ? `${diagnostic.resource}: ` : ""}${diagnostic.message}`)
  }
}
