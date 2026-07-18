import { cmd } from "./cmd"
import { ConfigV1 } from "@mongolgpt/core/v1/config/config"
import { effectCmd } from "../effect-cmd"
import { Cause } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@mongolgpt/core/v1/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { InstallationVersion } from "@mongolgpt/core/installation/version"
import path from "path"
import { Global } from "@mongolgpt/core/global"
import { modify, applyEdits } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { Effect } from "effect"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "MCP (Model Context Protocol) серверүүдийг удирдах",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "MCP серверүүд болон төлөвийг жагсаах",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("MCP сервер тохируулаагүй байна")
      prompts.outro("Add servers with: mongolgpt mcp add")
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "OAuth идэвхтэй MCP серверт нэвтрэх",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "MCP серверийн нэр",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth нэвтрэлт")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("OAuth боломжтой MCP сервер тохируулаагүй байна")
      prompts.log.info("Алсын MCP серверүүд OAuth-ийг анхдагчаар дэмждэг. mongolgpt.json дотор алсын сервер нэмнэ үү:")
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Дууслаа")
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Нэвтрэх MCP серверээ сонгоно уу",
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP сервер олдсонгүй: ${serverName}`)
      prompts.outro("Дууслаа")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`${serverName} MCP сервер OAuth боломжтой алсын сервер биш байна`)
      prompts.outro("Дууслаа")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} хүчинтэй credentials-тэй байна. Дахин нэвтрэх үү?`,
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Цуцлагдлаа")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName}-ийн credentials хугацаа дууссан байна. Дахин нэвтэрч байна...`)
    }

    const spinner = prompts.spinner()
    spinner.start("OAuth урсгал эхлүүлж байна...")

    yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop("Browser дээрээ authorize хийнэ үү:")
        prompts.log.info(url)
        spinner.start("Authorize хүлээж байна...")
      }),
    ).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Нэвтрэлт амжилттай!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Нэвтрэлт амжилтгүй", 1)
            prompts.log.error(status.error)
            prompts.log.info("MCP серверийн config-д clientId нэмнэ үү:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Нэвтрэлт амжилтгүй", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Хүлээгдээгүй төлөв: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Нэвтрэлт амжилтгүй", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
    )

    prompts.outro("Дууслаа")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "OAuth боломжтой MCP серверүүд болон нэвтрэлтийн төлөвийг жагсаах",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth төлөв")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("OAuth боломжтой MCP сервер тохируулаагүй байна")
      prompts.outro("Дууслаа")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth боломжтой сервер`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "MCP серверийн OAuth credentials-ийг устгах",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "MCP серверийн нэр",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth гарах")

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    if (serverNames.length === 0) {
      prompts.log.warn("MCP OAuth credential хадгалагдаагүй байна")
      prompts.outro("Дууслаа")
      return
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Гарах MCP серверээ сонгоно уу",
          options: serverNames.map((name) => {
            const entry = credentials[name]
            const hasTokens = !!entry.tokens
            const hasClient = !!entry.clientInfo
            let hint = ""
            if (hasTokens && hasClient) hint = "tokens + client"
            else if (hasTokens) hint = "tokens"
            else if (hasClient) hint = "client бүртгэл"
            return {
              label: name,
              value: name,
              hint,
            }
          }),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!credentials[serverName]) {
      prompts.log.error(`${serverName}-д credential олдсонгүй`)
      prompts.outro("Дууслаа")
      return
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(`${serverName}-ийн OAuth credentials устгагдлаа`)
    prompts.outro("Дууслаа")
  }),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // Prefer MongolGPT config names, then fall back to legacy names and hidden project directories.
  const candidates = [
    path.join(baseDir, "mongolgpt.json"),
    path.join(baseDir, "mongolgpt.jsonc"),
    path.join(baseDir, "opencode.json"),
    path.join(baseDir, "opencode.jsonc"),
  ]

  if (!global) {
    candidates.push(
      path.join(baseDir, ".mongolgpt", "mongolgpt.json"),
      path.join(baseDir, ".mongolgpt", "mongolgpt.jsonc"),
      path.join(baseDir, ".opencode", "opencode.json"),
      path.join(baseDir, ".opencode", "opencode.jsonc"),
    )
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to mongolgpt.json if none exist
  return candidates[0]
}

async function addMcpToConfig(name: string, mcpConfig: ConfigMCPV1.Info, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "MCP сервер нэмэх",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "MCP серверийн нэр",
        type: "string",
      })
      .option("url", {
        describe: "алсын MCP серверийн URL",
        type: "string",
      })
      .option("env", {
        describe: "локал MCP серверийн орчны хувьсагч (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "алсын MCP серверийн HTTP header (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef олдсонгүй")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      const command = args["--"] ?? []
      if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
        throw new Error("Интерактив бус MCP тохиргоонд серверийн нэр шаардлагатай")
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error("--url <url> эсвэл -- дараах командыг өгнө үү")
        }
        if (args.url && !URL.canParse(args.url)) {
          throw new Error(`Буруу URL: ${args.url}`)
        }
        if (args.url && args.env?.length) {
          throw new Error("--env зөвхөн локал MCP серверт хүчинтэй")
        }
        if (command.length && args.header?.length) {
          throw new Error("--header зөвхөн алсын MCP серверт хүчинтэй")
        }

        const entries = (values: string[], kind: string) =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(`Буруу ${kind}: ${entry}. KEY=VALUE байх ёстой`)
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "environment variable")
        const headers = entries(args.header ?? [], "HTTP header")
        const mcpConfig: ConfigMCPV1.Info = args.url
          ? {
              type: "remote",
              url: args.url,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        const configPath = await resolveConfigPath(Global.Path.config, true)
        await addMcpToConfig(args.name, mcpConfig, configPath)
        prompts.log.success(`"${args.name}" MCP сервер ${configPath} руу нэмэгдлээ`)
        return
      }

      UI.empty()
      prompts.intro("MCP сервер нэмэх")

      const project = ctx.project

      // Resolve config paths eagerly for hints
      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(ctx.worktree),
        resolveConfigPath(Global.Path.config, true),
      ])

      // Determine scope
      let configPath = globalConfigPath
      if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: "Байршил",
          options: [
            {
              label: "Одоогийн төсөл",
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: "Глобал",
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        configPath = scopeResult
      }

      const name = await prompts.text({
        message: "MCP серверийн нэр оруулна уу",
        validate: (x) => (x && x.length > 0 ? undefined : "Шаардлагатай"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "MCP серверийн төрлийг сонгоно уу",
        options: [
          {
            label: "Локал",
            value: "local",
            hint: "локал команд ажиллуулах",
          },
          {
            label: "Алсын",
            value: "remote",
            hint: "алсын URL руу холбогдох",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Ажиллуулах командыг оруулна уу",
          placeholder: "e.g., mongolgpt x @modelcontextprotocol/server-filesystem",
          validate: (x) => (x && x.length > 0 ? undefined : "Шаардлагатай"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCPV1.Info = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`"${name}" MCP сервер ${configPath} руу нэмэгдлээ`)
        prompts.outro("MCP сервер амжилттай нэмэгдлээ")
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "MCP серверийн URL оруулна уу",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Шаардлагатай"
            if (x.length === 0) return "Шаардлагатай"
            const isValid = URL.canParse(x)
            return isValid ? undefined : "Буруу URL"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Энэ сервер OAuth нэвтрэлт шаарддаг уу?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCPV1.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Урьдчилан бүртгэсэн client ID байгаа юу?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Client ID оруулна уу",
              validate: (x) => (x && x.length > 0 ? undefined : "Шаардлагатай"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Client secret байгаа юу?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Client secret оруулна уу",
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`"${name}" MCP сервер ${configPath} руу нэмэгдлээ`)
      }

      prompts.outro("MCP сервер амжилттай нэмэгдлээ")
    })
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "MCP серверийн OAuth холболтыг debug хийх",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "MCP серверийн нэр",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const serverConfig = config.mcp?.[args.name]
    const authInfo =
      serverConfig && isMcpRemote(serverConfig) && serverConfig.oauth !== false
        ? yield* Effect.all({
            authStatus: mcp.getAuthStatus(args.name),
            entry: auth.get(args.name),
          })
        : undefined
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("MCP OAuth Debug")

      const serverName = args.name

      if (!serverConfig) {
        prompts.log.error(`MCP сервер олдсонгүй: ${serverName}`)
        prompts.outro("Дууслаа")
        return
      }

      if (!isMcpRemote(serverConfig)) {
        prompts.log.error(`${serverName} MCP сервер алсын сервер биш байна`)
        prompts.outro("Дууслаа")
        return
      }

      if (serverConfig.oauth === false) {
        prompts.log.warn(`${serverName} MCP сервер дээр OAuth шууд идэвхгүй болгосон байна`)
        prompts.outro("Дууслаа")
        return
      }

      prompts.log.info(`Сервер: ${serverName}`)
      prompts.log.info(`URL: ${serverConfig.url}`)

      const { authStatus, entry } = authInfo!
      prompts.log.info(`Нэвтрэлтийн төлөв: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)

      if (entry?.tokens) {
        prompts.log.info(
          `  Access token: ${entry.tokens.accessToken.length > 8 ? `${entry.tokens.accessToken.slice(0, 4)}***${entry.tokens.accessToken.slice(-4)}` : "***"}`,
        )
        if (entry.tokens.expiresAt) {
          const expiresDate = new Date(entry.tokens.expiresAt * 1000)
          const isExpired = entry.tokens.expiresAt < Date.now() / 1000
          prompts.log.info(`  Дуусах хугацаа: ${expiresDate.toISOString()} ${isExpired ? "(ДУУССАН)" : ""}`)
        }
        if (entry.tokens.refreshToken) {
          prompts.log.info(`  Refresh token: байна`)
        }
      }
      if (entry?.clientInfo) {
        prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
        if (entry.clientInfo.clientSecretExpiresAt) {
          const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)
          prompts.log.info(`  Client secret дуусах хугацаа: ${expiresDate.toISOString()}`)
        }
      }

      const spinner = prompts.spinner()
      spinner.start("Холболт шалгаж байна...")

      // Test basic HTTP connectivity first
      try {
        const response = await fetch(serverConfig.url, {
          method: "POST",
          headers: {
            ...serverConfig.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "mongolgpt-debug", version: InstallationVersion },
            },
            id: 1,
          }),
        })

        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

        // Check for WWW-Authenticate header
        const wwwAuth = response.headers.get("www-authenticate")
        if (wwwAuth) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }

        if (response.status === 401) {
          prompts.log.warn("Сервер 401 Unauthorized буцаалаа")

          // Try to discover OAuth metadata
          const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
          const authProvider = new McpOAuthProvider(
            serverName,
            serverConfig.url,
            {
              clientId: oauthConfig?.clientId,
              clientSecret: oauthConfig?.clientSecret,
              scope: oauthConfig?.scope,
              redirectUri: oauthConfig?.redirectUri,
            },
            {
              onRedirect: async () => {},
            },
            auth,
          )

          prompts.log.info("OAuth урсгалыг шалгаж байна (authorization дуусгахгүй)...")

          // Try creating transport with auth provider to trigger discovery
          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
            authProvider,
            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
          })

          try {
            const client = new Client({
              name: "mongolgpt-debug",
              version: InstallationVersion,
            })
            await client.connect(transport)
            prompts.log.success("Холболт амжилттай (аль хэдийн нэвтэрсэн)")
            await client.close()
          } catch (error) {
            if (error instanceof UnauthorizedError) {
              prompts.log.info(`OAuth flow triggered: ${error.message}`)

              // Check if dynamic registration would be attempted
              const clientInfo = await authProvider.clientInformation()
              if (clientInfo) {
                prompts.log.info(`Client ID байна: ${clientInfo.client_id}`)
              } else {
                prompts.log.info("Client ID алга - dynamic registration оролдоно")
              }
            } else {
              prompts.log.error(`Холболтын алдаа: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } else if (response.status >= 200 && response.status < 300) {
          prompts.log.success("Сервер амжилттай хариуллаа (auth шаардлагагүй эсвэл аль хэдийн нэвтэрсэн)")
          const body = await response.text()
          try {
            const json = JSON.parse(body)
            if (json.result?.serverInfo) {
              prompts.log.info(`Серверийн мэдээлэл: ${JSON.stringify(json.result.serverInfo)}`)
            }
          } catch {
            // Not JSON, ignore
          }
        } else {
          prompts.log.warn(`Unexpected status: ${response.status}`)
          const body = await response.text().catch(() => "")
          if (body) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      } catch (error) {
        spinner.stop("Холболт амжилтгүй", 1)
        prompts.log.error(`Алдаа: ${error instanceof Error ? error.message : String(error)}`)
      }

      prompts.outro("Debug complete")
    })
  }),
})
