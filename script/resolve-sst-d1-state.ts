import { extractSstD1DatabaseId, SstD1StateError } from "@mongolgpt/script/sst-d1-state"

try {
  const source = await Bun.stdin.text()
  if (!source || source.length > 32 * 1024 * 1024) throw new SstD1StateError("SST state хоосон эсвэл хэт том байна.")
  const state: unknown = JSON.parse(source)
  process.stdout.write(`${extractSstD1DatabaseId(state)}\n`)
} catch (error) {
  if (error instanceof SstD1StateError || error instanceof SyntaxError) {
    console.error(`SST D1 state шалгалт амжилтгүй: ${error.message}`)
    process.exit(1)
  }
  throw error
}
