import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Exit } from "effect"
import { Npm } from "@mongolgpt/core/npm"
import { BundledPluginRuntime } from "@/plugin/vendor-runtime"
import { tmpdir } from "../fixture/fixture"

describe("BundledPluginRuntime", () => {
  test("loads the bundled plugin API from a clean config directory without a registry", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const prepared = await BundledPluginRuntime.prepare(config, { cache: path.join(tmp.path, "cache") })
    const manifest = JSON.parse(await fs.readFile(path.join(prepared.target, "package.json"), "utf8"))
    expect(manifest).toMatchObject({
      name: "@mongolgpt/plugin",
      version: prepared.version,
      mongolgptBundledRuntime: true,
    })

    const consumer = path.join(config, "verify-runtime.mjs")
    await fs.writeFile(
      consumer,
      [
        'import { tool } from "@mongolgpt/plugin"',
        'import { tool as directTool } from "@mongolgpt/plugin/tool"',
        'import { stringifyKeyStroke } from "@mongolgpt/plugin/tui"',
        'import { define as effectDefine } from "@mongolgpt/plugin/v2/effect"',
        'import "@mongolgpt/plugin/v2/effect/integration"',
        'import { define as pluginDefine } from "@mongolgpt/plugin/v2/effect/plugin"',
        'import { define as promiseDefine } from "@mongolgpt/plugin/v2/promise"',
        "export { tool, directTool, stringifyKeyStroke, effectDefine, pluginDefine, promiseDefine }",
        "",
      ].join("\n"),
    )
    const root = await import(`${pathToFileURL(consumer).href}?${crypto.randomUUID()}`)
    expect(root.directTool).toBe(root.tool)
    expect(root.stringifyKeyStroke).toBeFunction()
    expect(root.effectDefine).toBeFunction()
    expect(root.pluginDefine).toBeFunction()
    expect(root.promiseDefine).toBeFunction()

    const definition = root.tool({
      description: "Туршилтын хэрэгсэл",
      args: { value: root.tool.schema.string() },
      async execute(input: { value: string }) {
        return input.value
      },
    })
    expect(definition.description).toBe("Туршилтын хэрэгсэл")
    expect(definition.args.value.safeParse("ажиллав").success).toBe(true)
  })

  test("keeps the local runtime available when dependency installation fails", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const offline = {
      install: () => Effect.fail(new Npm.InstallFailedError({ dir: config, add: ["registry-offline"] })),
    } satisfies Pick<Npm.Interface, "install">
    const exit = await Effect.runPromiseExit(
      BundledPluginRuntime.install(offline, config, { cache: path.join(tmp.path, "cache") }),
    )
    expect(Exit.isFailure(exit)).toBe(true)

    const root = await import(
      `${pathToFileURL(path.join(config, "node_modules", "@mongolgpt", "plugin", "index.js")).href}?${crypto.randomUUID()}`
    )
    expect(root.tool).toBeFunction()
  })

  test("accepts the trusted local-package junction created by the installer", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const local = {
      install: (_directory: string, options?: { add: { name: string; version?: string }[] }) =>
        Effect.tryPromise(async () => {
          const version = options?.add[0]?.version
          if (!version) throw new Error("Локал runtime эх сурвалж алга")
          const source = fileURLToPath(version)
          const target = path.join(config, "node_modules", "@mongolgpt", "plugin")
          await fs.rename(target, `${target}-before-install`)
          await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir")
        }),
    } satisfies Pick<Npm.Interface, "install">

    await Effect.runPromise(BundledPluginRuntime.install(local, config, { cache: path.join(tmp.path, "cache") }))
    const target = path.join(config, "node_modules", "@mongolgpt", "plugin")
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
    const root = await import(`${pathToFileURL(path.join(target, "index.js")).href}?${crypto.randomUUID()}`)
    expect(root.tool).toBeFunction()
  })

  test("fails clearly when the proxy is imported outside the MongolGPT host", async () => {
    await using tmp = await tmpdir()
    const prepared = await BundledPluginRuntime.prepare(path.join(tmp.path, "config"), {
      cache: path.join(tmp.path, "cache"),
    })
    const target = `${pathToFileURL(path.join(prepared.source, "index.js")).href}?outside-host`
    const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(target)})`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain("багцалсан plugin runtime зөвхөн MongolGPT процесс дотор ажиллана")
  })

  test("refuses to follow a linked package directory", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const linked = path.join(tmp.path, "linked")
    await fs.mkdir(path.join(config, "node_modules"), { recursive: true })
    await fs.mkdir(linked)
    await fs.symlink(
      linked,
      path.join(config, "node_modules", "@mongolgpt"),
      process.platform === "win32" ? "junction" : "dir",
    )

    const rejected = await BundledPluginRuntime.prepare(config, { cache: path.join(tmp.path, "cache") }).then(
      () => undefined,
      (cause) => cause,
    )
    expect(String(rejected)).toContain("аюултай холбоос")
    expect(await fs.readdir(linked)).toEqual([])
  })
})
