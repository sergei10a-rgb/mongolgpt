import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { WslServersController } from "./servers"
import { requireWslIpcString } from "./policy"
import type { WslServersState } from "../../preload/types"
import { trustRendererIpc } from "../renderer-security"

const handle = <Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) => ipcMain.handle(channel, trustRendererIpc(listener))

export function registerWslIpcHandlers(controller: WslServersController) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }

  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  handle("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  handle("wsl-servers-get-state", () => controller.getState())
  handle("wsl-servers-probe-runtime", () => controller.probeRuntime())
  handle("wsl-servers-refresh-distros", () => controller.refreshDistros())
  handle("wsl-servers-install-wsl", () => controller.installWsl())
  handle("wsl-servers-install-distro", (_event, name: string) =>
    controller.installDistro(requireWslIpcString("distro", name)),
  )
  handle("wsl-servers-probe-distro", (_event, name: string) =>
    controller.probeDistro(requireWslIpcString("distro", name)),
  )
  handle("wsl-servers-probe-mongolgpt", (_event, name: string) =>
    controller.probeMongolGPT(requireWslIpcString("distro", name)),
  )
  handle("wsl-servers-install-mongolgpt", (_event, name: string) =>
    controller.installMongolGPT(requireWslIpcString("distro", name)),
  )
  handle("wsl-servers-open-terminal", (_event, name: string) =>
    controller.openTerminal(requireWslIpcString("distro", name)),
  )
  handle("wsl-servers-add", (_event, distro: string) =>
    controller.addServer(requireWslIpcString("distro", distro)),
  )
  handle("wsl-servers-remove", (_event, id: string) =>
    controller.removeServer(requireWslIpcString("server id", id)),
  )
  handle("wsl-servers-start", (_event, id: string) =>
    controller.startServer(requireWslIpcString("server id", id)),
  )
}

function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error("WSL зөвхөн Windows дээр боломжтой")
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: "WSL зөвхөн Windows дээр боломжтой",
    },
    installed: [],
    online: [],
    distroProbes: {},
    mongolgptChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })

  handle("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  handle("wsl-servers-unsubscribe", () => undefined)
  handle("wsl-servers-get-state", () => state())
  handle("wsl-servers-probe-runtime", unavailable)
  handle("wsl-servers-refresh-distros", unavailable)
  handle("wsl-servers-install-wsl", unavailable)
  handle("wsl-servers-install-distro", unavailable)
  handle("wsl-servers-probe-distro", unavailable)
  handle("wsl-servers-probe-mongolgpt", unavailable)
  handle("wsl-servers-install-mongolgpt", unavailable)
  handle("wsl-servers-open-terminal", unavailable)
  handle("wsl-servers-add", unavailable)
  handle("wsl-servers-remove", unavailable)
  handle("wsl-servers-start", unavailable)
}
