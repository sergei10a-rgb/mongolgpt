import type { Plugin } from "@mongolgpt/plugin"
import { rename, writeFile } from "node:fs/promises"
import { randomInt } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

const DEV_DATA_FILE = "/tmp/mongolgpt-workspace-dev-data.json"
const DEV_DATA_TEMP_FILE = `${DEV_DATA_FILE}.tmp`

async function waitForHealth(port: number) {
  const url = `http://127.0.0.1:${port}/global/health`
  const started = Date.now()

  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {}

    await sleep(250)
  }

  throw new Error(`${url} дээрх debug серверийн төлөвийн шалгалтыг хүлээх хугацаа дууслаа`)
}

let PORT: number | undefined

async function writeDebugData(port: number, id: string, env: Record<string, string | undefined>) {
  await writeFile(
    DEV_DATA_TEMP_FILE,
    JSON.stringify(
      {
        port,
        id,
        env,
      },
      null,
      2,
    ),
  )

  await rename(DEV_DATA_TEMP_FILE, DEV_DATA_FILE)
}

export const DebugWorkspacePlugin: Plugin = async ({ experimental_workspace }) => {
  experimental_workspace.register("debug", {
    name: "Дибаг",
    description: "Дибаг хийх сервер үүсгэх",
    configure(config) {
      return config
    },
    async create(config, env) {
      const port = randomInt(5000, 9001)
      PORT = port

      await writeDebugData(port, config.id, env)

      await waitForHealth(port)
    },
    async remove(_config) {},
    target(_config) {
      return {
        type: "remote",
        url: `http://localhost:${PORT!}/`,
      }
    },
  })

  return {}
}

export default DebugWorkspacePlugin
