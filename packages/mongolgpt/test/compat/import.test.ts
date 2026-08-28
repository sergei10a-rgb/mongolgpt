import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { applyCompatImport, planCompatImport } from "../../src/compat"
import type { CompatOperation } from "../../src/compat"
import type { InstanceContext } from "../../src/project/instance-context"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

function ctx(dir: string): InstanceContext {
  return {
    directory: dir,
    worktree: dir,
    project: { id: "test" } as InstanceContext["project"],
  }
}

function mcp(operation: CompatOperation) {
  if (operation.kind !== "mcp") throw new Error(`Expected MCP operation, got ${operation.kind}`)
  return operation
}

function plugin(operation: CompatOperation) {
  if (operation.kind !== "plugin") throw new Error(`Expected plugin operation, got ${operation.kind}`)
  return operation
}

describe("compat import", () => {
  test("plans Claude Desktop MCP config without writing files", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "claude_desktop_config.json")
    await Bun.write(
      source,
      JSON.stringify(
        {
          mcpServers: {
            higgsfield: {
              command: "npx",
              args: ["-y", "@higgsfield/mcp"],
              env: {
                HIGGSFIELD_API_KEY: "secret",
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const plan = await planCompatImport({ source, project: true }, ctx(tmp.path))
    const operation = mcp(plan.prepared[0])

    expect(plan.configPath).toBe(path.join(tmp.path, ".mongolgpt", "mongolgpt.jsonc"))
    expect(operation.name).toBe("higgsfield")
    expect(operation.config).toEqual({
      type: "local",
      command: ["npx", "-y", "@higgsfield/mcp"],
      environment: { HIGGSFIELD_API_KEY: "secret" },
    })
    expect(plan.nextConfigText).toContain("higgsfield")
    expect(await Filesystem.exists(plan.configPath)).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".mongolgpt", "plugins"))).toBe(false)
  })

  test("plans Codex TOML MCP servers and converts second timeouts", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "config.toml")
    await Bun.write(
      source,
      `[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
tool_timeout_sec = 45
startup_timeout_sec = 20
enabled_tools = ["search"]

[mcp_servers.context7.env]
LOCAL_TOKEN = "secret"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
http_headers = { X-Figma-Region = "us-east-1" }
`,
    )

    const plan = await planCompatImport({ source, project: true }, ctx(tmp.path))
    const servers = Object.fromEntries(
      plan.prepared
        .filter((operation) => operation.kind === "mcp")
        .map((operation) => [operation.name, operation.config]),
    )

    expect(servers.context7).toEqual({
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp"],
      environment: { LOCAL_TOKEN: "secret" },
      timeout: 45_000,
    })
    expect(servers.figma).toEqual({
      type: "remote",
      url: "https://mcp.figma.com/mcp",
      headers: { "X-Figma-Region": "us-east-1" },
    })
    expect(plan.warnings.some((warning) => warning.includes("startup_timeout_sec"))).toBe(true)
    expect(plan.warnings.some((warning) => warning.includes("enabled_tools"))).toBe(true)
  })

  test("plans Goose YAML stdio and remote extensions", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "config.yaml")
    await Bun.write(
      source,
      `extensions:
  github:
    name: GitHub
    cmd: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    envs:
      GITHUB_TOKEN: secret
    enabled: true
    type: stdio
    timeout: 300
  remote-example:
    name: Remote Example
    type: streamable_http
    uri: https://example.com/mcp
    enabled: false
    timeout: 30
  developer:
    type: builtin
    enabled: true
`,
    )

    const plan = await planCompatImport({ source, project: true }, ctx(tmp.path))
    const servers = Object.fromEntries(
      plan.prepared
        .filter((operation) => operation.kind === "mcp")
        .map((operation) => [operation.name, operation.config]),
    )

    expect(servers.github).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "secret" },
      timeout: 300_000,
    })
    expect(servers["remote-example"]).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      enabled: false,
      timeout: 30_000,
    })
    expect(servers.developer).toBeUndefined()
  })

  test("plans Hermes YAML mcp_servers", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "config.yaml")
    await Bun.write(
      source,
      `mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    timeout: 120
    connect_timeout: 60
  docs:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: Bearer secret
    enabled: false
`,
    )

    const plan = await planCompatImport({ source, project: true }, ctx(tmp.path))
    const servers = Object.fromEntries(
      plan.prepared
        .filter((operation) => operation.kind === "mcp")
        .map((operation) => [operation.name, operation.config]),
    )

    expect(servers.filesystem).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      timeout: 120_000,
    })
    expect(servers.docs).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret" },
      enabled: false,
    })
    expect(plan.warnings.some((warning) => warning.includes("connect_timeout"))).toBe(true)
  })

  test("aggregates skill, MCP, and plugin operations from one directory", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "SKILL.md"), "---\nname: shared\ndescription: Shared skill\n---\n")
    await Bun.write(path.join(tmp.path, "package.json"), '{"name":"shared-plugin"}')
    await fs.mkdir(path.join(tmp.path, ".codex"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".codex", "config.toml"),
      `[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`,
    )

    const plan = await planCompatImport({ source: tmp.path, project: true }, ctx(tmp.path))

    expect(plan.prepared.map((operation) => operation.kind)).toEqual(["skill-path", "mcp", "plugin"])
  })

  test("warns when aggregated MCP sources use the same name with different configs", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, ".codex"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, ".hermes"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".codex", "config.toml"),
      `[mcp_servers.docs]
url = "https://codex.example.com/mcp"
`,
    )
    await Bun.write(
      path.join(tmp.path, ".hermes", "config.yaml"),
      `mcp_servers:
  docs:
    url: https://hermes.example.com/mcp
`,
    )

    const plan = await planCompatImport({ source: tmp.path, project: true }, ctx(tmp.path))

    expect(plan.prepared.filter((operation) => operation.kind === "mcp")).toHaveLength(2)
    expect(plan.warnings.some((warning) => warning.includes('MCP "docs" нэр'))).toBe(true)
  })

  test("rejects oversized config before parsing", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "config.yaml")
    await Bun.write(source, `mcp_servers: {}\n# ${"x".repeat(2 * 1024 * 1024)}`)

    const failure = await planCompatImport({ source, project: true }, ctx(tmp.path)).then(
      () => undefined,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("Хэмжээний алдаа буцаагдсангүй")
    expect(failure.message).toContain("2 MiB")
  })

  test("rejects malformed YAML before writing config", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "config.yaml")
    await Bun.write(source, "mcp_servers:\n  broken: [")

    const failure = await applyCompatImport({ source, project: true }, ctx(tmp.path)).then(
      () => undefined,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("YAML алдаа буцаагдсангүй")
    expect(failure.message).toContain("YAML")
    expect(await Filesystem.exists(path.join(tmp.path, ".mongolgpt", "mongolgpt.jsonc"))).toBe(false)
  })

  test("applies command import while preserving JSONC comments", async () => {
    await using tmp = await tmpdir()
    const configDir = path.join(tmp.path, ".mongolgpt")
    await fs.mkdir(configDir, { recursive: true })
    const configPath = path.join(configDir, "mongolgpt.jsonc")
    await Bun.write(
      configPath,
      `{
  // хадгалагдах тайлбар
  "plugin": ["existing-plugin"],
}
`,
    )

    const plan = await applyCompatImport(
      {
        project: true,
        name: "local",
        mcpCommand: 'npx -y @modelcontextprotocol/server-filesystem "two words"',
        env: ["TOKEN=one=two"],
      },
      ctx(tmp.path),
    )

    const text = await Filesystem.readText(configPath)
    const data = parseJsonc(text) as any
    expect(plan.outcomes.map((item) => item.mode)).toEqual(["add"])
    expect(text).toContain("// хадгалагдах тайлбар")
    expect(data.mcp.local.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem", "two words"])
    expect(data.mcp.local.environment).toEqual({ TOKEN: "one=two" })
    expect(data.plugin).toEqual(["existing-plugin"])
  })

  test("plans plugin adapter without creating adapter files", async () => {
    await using tmp = await tmpdir()
    const plan = await planCompatImport({ source: "acme-plugin", type: "plugin", project: true }, ctx(tmp.path))
    const operation = plugin(plan.prepared[0])
    const spec = Array.isArray(operation.spec) ? operation.spec[0] : operation.spec

    expect(operation.adapter?.format).toBe("planned-js")
    expect(operation.adapter?.original).toBe("acme-plugin")
    expect(spec).toContain("./plugins/adapters/acme-plugin-")
    expect(spec).toContain(".compat.js")
    expect(operation.adapter?.file.startsWith(path.join(tmp.path, ".mongolgpt", "plugins", "adapters"))).toBe(true)
    expect(await Filesystem.exists(operation.adapter?.file ?? "")).toBe(false)
  })

  test("plans an explicit plugin directory without package metadata", async () => {
    await using tmp = await tmpdir()
    const pluginDir = path.join(tmp.path, "plain-plugin")
    await fs.mkdir(pluginDir, { recursive: true })
    await Bun.write(path.join(pluginDir, "index.js"), "export default {}")

    const plan = await planCompatImport({ source: pluginDir, type: "plugin", project: true }, ctx(tmp.path))

    expect(plan.prepared).toHaveLength(1)
    expect(plan.prepared[0].kind).toBe("plugin")
  })

  test("rejects local plugin entrypoints outside the plugin directory before writing config", async () => {
    await using tmp = await tmpdir()
    const pluginDir = path.join(tmp.path, "foreign-plugin")
    await fs.mkdir(pluginDir, { recursive: true })
    await Bun.write(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "foreign-plugin",
          main: "../outside.js",
        },
        null,
        2,
      ),
    )
    await Bun.write(path.join(tmp.path, "outside.js"), "export default {}")

    await expect(
      applyCompatImport({ source: "./foreign-plugin", type: "plugin", project: true }, ctx(tmp.path)),
    ).rejects.toThrow("гадагш")
    expect(await Filesystem.exists(path.join(tmp.path, ".mongolgpt", "mongolgpt.jsonc"))).toBe(false)
  })

  test("rejects unclosed shell quotes", async () => {
    await using tmp = await tmpdir()

    await expect(
      planCompatImport({ project: true, mcpCommand: 'npx -y "unterminated' }, ctx(tmp.path)),
    ).rejects.toThrow("quote")
  })
})
