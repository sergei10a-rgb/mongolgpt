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
