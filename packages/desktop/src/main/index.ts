import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event, MessageBoxOptions } from "electron"
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { DesktopAccountAPI, ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { createDesktopAccountClient } from "./account-client"
import { loadOrCreateAccountVaultKey } from "./account-vault-key"
import { ACCOUNT_SERVER_URL, CHANNEL, WEB_APP_ORIGIN } from "./constants"
import { describeDeepLink, describeDeepLinks, isLocalBridgePairingDeepLink } from "./deep-link-security"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { createLocalBridgeGateway } from "./local-bridge-gateway"
import { createDesktopLocalBridgePairingController, DesktopLocalBridgePairingError } from "./local-bridge-pairing"
import { runReleaseFunctionalSmoke } from "./release-functional-smoke"
import {
  desktopSmokeFile,
  rendererSmokeFailure,
  waitForRendererAccountGate,
  waitForRendererReady,
  writeDesktopSmokeResult,
} from "./release-smoke"
import { getStore } from "./store"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"

const APP_NAMES: Record<string, string> = {
  dev: "MongolGPT Dev",
  beta: "MongolGPT Beta",
  prod: "MongolGPT",
}
const APP_IDS: Record<string, string> = {
  dev: "org.mongolgpt.desktop.dev",
  beta: "org.mongolgpt.desktop.beta",
  prod: "org.mongolgpt.desktop",
}
const TEST_ONBOARDING = process.env.MONGOLGPT_TEST_ONBOARDING === "1" || process.env.OPENCODE_TEST_ONBOARDING === "1"
const DESKTOP_SMOKE_FILE = desktopSmokeFile()
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
let fatalRendererError: { error: string } | undefined

const pendingDeepLinks: string[] = []
const pendingLocalBridgePairings: string[] = []
const MAX_PENDING_LOCAL_BRIDGE_PAIRINGS = 8
let localBridgePairingHandler: ((url: string) => Promise<void>) | undefined
let localBridgePairingQueue = Promise.resolve()

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("Прокси орчныг ачаалж чадсангүй", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function queueLocalBridgePairing(url: string) {
  const handler = localBridgePairingHandler
  if (!handler) {
    pendingLocalBridgePairings.push(url)
    if (pendingLocalBridgePairings.length > MAX_PENDING_LOCAL_BRIDGE_PAIRINGS) pendingLocalBridgePairings.shift()
    return
  }
  localBridgePairingQueue = localBridgePairingQueue.then(() => handler(url)).catch(() => undefined)
}

function routeDeepLinks(urls: string[]) {
  const renderer: string[] = []
  for (const url of urls) {
    if (isLocalBridgePairingDeepLink(url)) queueLocalBridgePairing(url)
    else renderer.push(url)
  }
  emitDeepLinks(renderer)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // macOS apps start in `/`, which can cause issues with ripgrep.
  if (process.platform === "darwin") {
    try {
      process.chdir(homedir())
    } catch {}
  }

  process.env.MONGOLGPT_DISABLE_EMBEDDED_WEB_UI = "true"
  process.env.MONGOLGPT_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "org.mongolgpt.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `mongolgpt-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.MONGOLGPT_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "MongolGPT Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("WSL дагалдах серверийг эхлүүлж байна", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("WSL дагалдах сервер", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  let localBridgeGateway: ReturnType<typeof createLocalBridgeGateway> | undefined
  const stopSidecars = async () => {
    const gateway = localBridgeGateway
    localBridgeGateway = undefined
    await Promise.all([killSidecar(), gateway?.stop() ?? Promise.resolve()])
    wslServers.stopAll()
  }
  const relaunch = () => {
    void stopSidecars().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("Системийн сертификатуудыг ачаалж чадсангүй", error)
  }

  logger.log("Апп эхэлж байна", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("mongolgpt://"))
    if (urls.length) {
      logger.log("Deep link-ийг second-instance-ээр хүлээн авлаа", { actions: describeDeepLinks(urls) })
      routeDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("Deep link-ийг open-url-ээр хүлээн авлаа", { action: describeDeepLink(url) })
    routeDeepLinks([url])
  })

  app.on("before-quit", () => {
    void stopSidecars()
  })

  app.on("will-quit", () => {
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "Дэд процесс дууслаа", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "Аппын дүрслэх процесс дууслаа", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  const bridge = createLocalBridgeGateway({
    sidecar: () => Effect.runPromise(Deferred.await(serverReady)),
  })
  localBridgeGateway = bridge
  const baseAccount = createDesktopAccountClient({
    server: () => Effect.runPromise(Deferred.await(serverReady)),
    accountServer: ACCOUNT_SERVER_URL,
    openExternal: (url) => shell.openExternal(url),
  })
  const account: DesktopAccountAPI = {
    current: baseAccount.current,
    overview: baseAccount.overview,
    switchWorkspace: async (workspaceID) => {
      bridge.revokeAll()
      return baseAccount.switchWorkspace(workspaceID)
    },
    login: async () => {
      bridge.revokeAll()
      return baseAccount.login()
    },
    logout: async () => {
      bridge.revokeAll()
      await baseAccount.logout()
    },
  }

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient("mongolgpt")
  registerRendererProtocol()
  setDockIcon()
  const showDesktopMessage = (options: MessageBoxOptions) =>
    mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)
  const pairing = createDesktopLocalBridgePairingController({
    allowedOrigins: [WEB_APP_ORIGIN],
    currentAccount: account.current,
    authorize: bridge.authorize,
    openExternal: (url) => shell.openExternal(url),
    confirm: async (request) => {
      const result = await showDesktopMessage({
        type: "question",
        title: "MongolGPT Web холболт",
        message: "MongolGPT Web-ийг энэ компьютертэй холбох уу?",
        detail: `${request.origin} хаягийн веб аппад энэ компьютер дээрх төсөл, файл, терминал болон локал загварт хандах эрх олгоно.`,
        buttons: ["Холбох", "Цуцлах"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0
    },
  })
  localBridgePairingHandler = async (url) => {
    try {
      const result = await pairing.handle(url)
      logger.log("Дотоод холболтын хүсэлтийг боловсрууллаа", { status: result.status })
    } catch (error) {
      const pairingError = error instanceof DesktopLocalBridgePairingError ? error : undefined
      logger.warn("Дотоод холболтын хүсэлт амжилтгүй боллоо", {
        code: pairingError?.code ?? "operation_failed",
      })
      await showDesktopMessage({
        type: "error",
        title: "Дотоод холболтын алдаа",
        message: pairingError?.message ?? "Дотоод холболтыг дуусгаж чадсангүй",
        buttons: ["Хаах"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    }
  }
  for (const url of pendingLocalBridgePairings.splice(0)) queueLocalBridgePairing(url)
  if (process.platform !== "darwin") {
    routeDeepLinks(process.argv.filter((arg) => arg.startsWith("mongolgpt://")))
  }
  const updater = setupAutoUpdater(stopSidecars)
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("Сервер бэлэн болохыг хүлээж байна")
        const res = yield* Deferred.await(serverReady)
        logger.log("Сервер бэлэн боллоо", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    account,
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => {
      fatalRendererError ??= error
      writeLog("renderer", "Дүрслэх процессын ноцтой алдаа", { ...error }, "error")
    },
  })
  registerWslIpcHandlers(wslServers)
  if (!DESKTOP_SMOKE_FILE) {
    void updater.start()
    const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
    updateTimer.unref()
    app.once("will-quit", () => clearInterval(updateTimer))
  }
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("Сүлжээний логийг эхлүүлж чадсангүй", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.MONGOLGPT_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Порт авахад алдаа гарлаа."))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("Дагалдах серверийн холболт эхэллээ", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("Дагалдах серверийг эхлүүлж байна", { url })
    const { listener, health } = yield* Effect.tryPromise({
      try: async () => {
        const secureStore = getStore("mongolgpt.secure")
        const accountVaultKey = loadOrCreateAccountVaultKey({
          storage: {
            get: (key) => {
              const value = secureStore.get(key)
              return typeof value === "string" ? value : undefined
            },
            set: (key, value) => secureStore.set(key, value),
          },
          safeStorage: {
            isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
            getSelectedStorageBackend:
              process.platform === "linux" ? () => safeStorage.getSelectedStorageBackend() : undefined,
            encryptString: (value) => safeStorage.encryptString(value),
            decryptString: (value) => safeStorage.decryptString(Buffer.from(value)),
          },
          randomness: { randomBytes },
        })

        try {
          return await spawnLocalServer(hostname, port, password, {
            userDataPath: app.getPath("userData"),
            accountVaultKey,
            onStdout: (message) => writeLog("server", "stdout", { message }),
            onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
            onExit: (code) => writeLog("utility", "Дагалдах сервер дууслаа", { code }, "warn"),
          })
        } finally {
          accountVaultKey.fill(0)
        }
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "mongolgpt",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("WSL серверийг эхлүүлж чадсангүй", error))
    }

    const healthCheck = Effect.promise(() => health.wait).pipe(Effect.timeout("30 seconds"))
    if (DESKTOP_SMOKE_FILE) {
      yield* healthCheck
    } else {
      yield* healthCheck.pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            logger.error("Дагалдах серверийн эрүүл мэндийн шалгалт амжилтгүй боллоо", e.toString())
          }),
        ),
      )
    }

    logger.log("Ачаалах ажил дууслаа")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  if (DESKTOP_SMOKE_FILE) yield* Fiber.join(loadingTask)
  else yield* Fiber.await(loadingTask)

  mainWindow = createMainWindow()
  if (DESKTOP_SMOKE_FILE) {
    const smokeWindow = mainWindow
    if (!smokeWindow) {
      yield* Effect.fail(new Error("Desktop smoke шалгалтад үндсэн цонх үүссэнгүй."))
      return
    }
    const rendererUrl = yield* Effect.tryPromise({
      try: () => waitForRendererReady(smokeWindow.webContents),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    const accountGate = yield* Effect.tryPromise({
      try: () => waitForRendererAccountGate(smokeWindow.webContents),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    const rendererFailure = rendererSmokeFailure(fatalRendererError)
    if (rendererFailure) yield* Effect.fail(rendererFailure)
    const functional = yield* Effect.tryPromise({
      try: () =>
        runReleaseFunctionalSmoke({
          url,
          username: "mongolgpt",
          password,
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    if (!functional.capable) {
      yield* Effect.fail(
        new Error(`Desktop functional smoke шалгалт амжилтгүй боллоо: ${JSON.stringify(functional.summary)}`),
      )
    }
    yield* Effect.try({
      try: () =>
        writeDesktopSmokeResult(DESKTOP_SMOKE_FILE, {
          version: app.getVersion(),
          url: rendererUrl,
          functional,
          ...accountGate,
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    yield* Effect.promise(stopSidecars)
    app.exit(0)
    return
  }
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

Effect.runFork(main)
