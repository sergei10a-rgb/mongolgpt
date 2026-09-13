import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"

assert.equal(process.platform, "darwin", "Run this acceptance check on macOS")
const version = process.env.MONGOLGPT_VERSION
assert.ok(version, "An exact preview version is required")
const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "mongolgpt-mac-acceptance-"))
const dist = resolve("dist")
const output = resolve(process.env.MONGOLGPT_MAC_ARTIFACT || join(root, "evidence"))
await mkdir(output, { recursive: true })
const name = "MongolGPT Dev.app"
const packaged = join(dist, process.arch === "arm64" ? "mac-arm64" : "mac", name)
await smoke(packaged, "packaged")

// Mount the exact distributable read-only and launch a copied app, as a DMG install does.
const mount = join(root, "mounted")
await mkdir(mount)
execFileSync("hdiutil", [
  "attach",
  join(dist, `mongolgpt-desktop-mac-${process.arch}.dmg`),
  "-readonly",
  "-nobrowse",
  "-mountpoint",
  mount,
])
try {
  const installed = join(root, "installed", name)
  execFileSync("ditto", [join(mount, name), installed])
  await smoke(installed, "installed")
} finally {
  execFileSync("hdiutil", ["detach", mount])
}

async function smoke(app: string, mode: string) {
  const plist = join(app, "Contents", "Info.plist")
  const property = (key: string) =>
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim()
  assert.equal(property("CFBundleIdentifier"), "org.mongolgpt.desktop.dev")
  assert.equal(property("CFBundleShortVersionString"), version)
  assert.equal(property("CFBundleName"), "MongolGPT Dev")
  const executable = join(app, "Contents", "MacOS", property("CFBundleExecutable"))
  assert.equal(
    execFileSync("lipo", ["-archs", executable], { encoding: "utf8" }).trim(),
    process.arch === "arm64" ? "arm64" : "x86_64",
  )
  execFileSync("codesign", ["--verify", "--deep", "--strict", app])
  const icon = property("CFBundleIconFile")
  const iconPath = join(app, "Contents", "Resources", icon.endsWith(".icns") ? icon : `${icon}.icns`)
  await access(iconPath)
  execFileSync("sips", [
    "-s",
    "format",
    "png",
    iconPath,
    "--out",
    join(output, `mongolgpt-mac-${process.arch}-${mode}-icon.png`),
  ])
  const marker = join(output, `mongolgpt-mac-${process.arch}-${mode}.json`)
  const log = createWriteStream(`${marker}.log`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MONGOLGPT_TEST_ONBOARDING: "1",
    MONGOLGPT_DESKTOP_SMOKE_FILE: marker,
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MONGOLGPT_DESKTOP_SMOKE_EXTERNAL_PTY_PROOF
  const child = spawn(executable, ["--enable-logging=stderr"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  try {
    assert.equal(
      await Promise.race([exited, setTimeout(180_000, "timeout", { ref: false })]),
      0,
      "macOS app did not exit cleanly",
    )
    const result = JSON.parse(await readFile(marker, "utf8"))
    assert.equal(result.status, "ready", result.error)
    assert.equal(result.version, version)
    assert.match(result.url, /^mongolgpt-renderer:\/\/renderer\//)
    assert.equal(result.language, "mn")
    assert.equal(result.onboardingStage, "account")
    assert.equal(result.accountGateVisible, true)
    assert.equal(result.accountLogo, "mongolgpt")
    assert.equal(result.accountHeading, "MongolGPT бүртгэлээрээ нэвтэрнэ үү")
    assert.equal(result.loginAction, "Бүртгүүлэх эсвэл нэвтрэх")
    assert.equal(result.functional.capable, true)
    const http = Object.values(result.functional.summary.http) as { ok: boolean }[]
    assert.equal(http.length, 15)
    assert.ok(http.every((check) => check.ok === true))
    assert.equal(result.functional.summary.terminal.ok, true)
    for (const key of ["skill", "tool", "config", "mcpConfiguredDisabled", "localModelInference"]) {
      assert.equal(result.functional.summary.fixture[key], true, key)
    }
    const png = await readFile(`${marker}.png`)
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(result.screenshot.bytes, png.length)
    assert.ok(result.screenshot.width > 300 && result.screenshot.height > 300)
    assert.equal(png.readUInt32BE(16), result.screenshot.width)
    assert.equal(png.readUInt32BE(20), result.screenshot.height)
    await writeFile(
      `${marker}.acceptance.json`,
      JSON.stringify({ platform: process.platform, arch: process.arch, version, mode, app, result }, null, 2),
    )
    console.log(JSON.stringify({ mode, arch: process.arch, version, passed: true, screenshot: `${marker}.png` }))
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await exited.catch(() => undefined)
    log.end()
  }
}
