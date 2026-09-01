import {
  formatSstAdminExternalStateEnv,
  readSstAdminExternalStateFile,
  SstAdminExternalStateError,
} from "../packages/script/src/sst-admin-external-state.ts"

async function main() {
  const path = process.argv[2]
  if (!path) throw new SstAdminExternalStateError("SST state file path дутуу байна.")

  const state = await readSstAdminExternalStateFile(path)
  process.stdout.write(`${formatSstAdminExternalStateEnv(state).join("\n")}\n`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (error instanceof SstAdminExternalStateError || error instanceof SyntaxError || error instanceof Error) {
      console.error(`SST admin external state шалгалт амжилтгүй: ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}
