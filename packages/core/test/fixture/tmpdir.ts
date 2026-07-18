import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

export const tmpdir = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(osTmpdir(), "mongolgpt-core-test-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await remove(dir)
    },
  }
}

const transientWindowsErrors = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"])

async function remove(dir: string, retries = process.platform === "win32" ? 60 : 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (
      retries === 0 ||
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      (error.code !== "EBUSY" && (process.platform !== "win32" || !transientWindowsErrors.has(error.code)))
    )
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
