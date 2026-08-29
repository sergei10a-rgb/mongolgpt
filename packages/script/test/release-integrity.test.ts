import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  CLI_RELEASE_ASSETS,
  DESKTOP_RELEASE_ASSETS,
  RELEASE_CHECKSUM_ASSET,
  RELEASE_ARTIFACTS,
  createSha256Sums,
  releaseTag,
  validateReleaseChecksumContract,
} from "../src/release-integrity"

const files = RELEASE_ARTIFACTS.map((name) => ({ name, bytes: new TextEncoder().encode(name) }))
const root = resolve(import.meta.dirname, "../../..")

describe("release integrity contract", () => {
  test("uses one validated MongolGPT release tag namespace", () => {
    expect(releaseTag("0.1.2")).toBe("mongolgpt-v0.1.2")
    expect(releaseTag("0.1.2-beta.1")).toBe("mongolgpt-v0.1.2-beta.1")
    expect(() => releaseTag("v0.1.2")).toThrow("invalid MongolGPT release version")
    expect(() => releaseTag(" 0.1.2")).toThrow("invalid MongolGPT release version")

    for (const file of [
      "script/version.ts",
      "script/publish.ts",
      "packages/desktop/scripts/finalize-latest-yml.ts",
      "packages/desktop/scripts/finalize-latest-json.ts",
    ]) {
      expect(readFileSync(resolve(root, file), "utf8")).toContain("releaseTag(")
    }

    const versionScript = readFileSync(resolve(root, "script/version.ts"), "utf8")
    expect(versionScript).toContain("account_url=${resolveProductServiceUrls(Script.channel).console}")
  })

  test("creates stable lowercase basenames in sorted order", () => {
    const text = createSha256Sums([...files].reverse())
    const lines = text.trimEnd().split("\n")
    expect(lines.map((line) => line.slice(66))).toEqual([...RELEASE_ARTIFACTS].sort())
    expect(lines.every((line) => /^[0-9a-f]{64}  [^\\/]+$/.test(line))).toBe(true)
  })

  test("includes the Windows ARM64 CLI archive in the public release contract", () => {
    expect(CLI_RELEASE_ASSETS).toContain("mongolgpt-windows-arm64.zip")
    expect(RELEASE_ARTIFACTS).toContain("mongolgpt-windows-arm64.zip")
  })

  test("fails closed when a CLI or Desktop artifact is absent", () => {
    expect(() => createSha256Sums(files.filter((file) => file.name !== CLI_RELEASE_ASSETS[0]))).toThrow(
      CLI_RELEASE_ASSETS[0],
    )
    expect(() => createSha256Sums(files.filter((file) => file.name !== DESKTOP_RELEASE_ASSETS[0]))).toThrow(
      DESKTOP_RELEASE_ASSETS[0],
    )
  })

  test("validates the checksum asset and exact artifact coverage", () => {
    const text = createSha256Sums(files)
    expect(validateReleaseChecksumContract([...RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET], text)).toEqual([])
    expect(validateReleaseChecksumContract(RELEASE_ARTIFACTS, text)).toEqual([`missing ${RELEASE_CHECKSUM_ASSET}`])
    expect(
      validateReleaseChecksumContract(
        [...RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET],
        text.replace(RELEASE_ARTIFACTS[0], "0".repeat(64)),
      ),
    ).toContain(`checksum missing artifacts: ${RELEASE_ARTIFACTS[0]}`)
  })

  test("excludes source maps and other non-user release files", () => {
    const text = createSha256Sums([...files, { name: "mongolgpt-desktop-win-x64.exe.map", bytes: new Uint8Array() }])
    expect(text).not.toContain(".map")
    expect(validateReleaseChecksumContract([...RELEASE_ARTIFACTS, RELEASE_CHECKSUM_ASSET], text)).toEqual([])
  })

  test("authenticates npm publish and verifies every public package", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const publish = readFileSync(resolve(root, "script/publish.ts"), "utf8")
    const cliPublish = readFileSync(resolve(root, "packages/mongolgpt/script/publish.ts"), "utf8")
    const cliBuild = readFileSync(resolve(root, "packages/mongolgpt/script/build.ts"), "utf8")
    const preflight = readFileSync(resolve(root, "packages/mongolgpt/script/release-preflight.ts"), "utf8")
    const cliManifest = JSON.parse(readFileSync(resolve(root, "packages/mongolgpt/package.json"), "utf8"))

    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")
    expect(publish.indexOf("script/npm-publish-access.ts")).toBeLessThan(
      publish.indexOf("packages/mongolgpt/script/publish.ts"),
    )
    expect(publish.indexOf("packages/ui/script/publish.ts")).toBeLessThan(publish.indexOf("release-preflight.ts --npm"))
    for (const name of ["@mongolgpt/sdk", "@mongolgpt/plugin", "@mongolgpt/ui"]) {
      expect(preflight).toContain(`"${name}"`)
    }
    expect(preflight).toContain("smokePublicNpmInstall(version)")
    expect(preflight).toContain("delete publicEnv[key]")
    expect(preflight).toContain("NPM_CONFIG_USERCONFIG: npmrc")
    expect(preflight).toContain("`mongolgpt@${version}`")
    expect(preflight).toContain('["account", "--help"]')
    expect(preflight).toContain('"MongolGPT бүртгэл"')
    expect(preflight).toContain('"mongolgpt/free-auto"')
    expect(preflight).toContain('"mongolgpt account login"')
    expect(cliManifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/sergei10a-rgb/mongolgpt.git",
      directory: "packages/mongolgpt",
    })
    expect(cliManifest.homepage).toBe("https://mgpt.mn/")
    expect(cliManifest.bugs?.url).toBe("https://github.com/sergei10a-rgb/mongolgpt/issues")
    expect(cliPublish).toContain("cp ./README.md")
    expect(cliPublish).toContain("description: pkg.description")
    expect(cliPublish).toContain("repository: pkg.repository")
    expect(cliBuild).toContain("description: `${pkg.description}")
    expect(cliBuild).toContain("repository: pkg.repository")
    expect(preflight).toContain('main.files?.includes("README.md")')
  })

  test("keeps dev npm preview builds separate from guarded publishing", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish-dev-cli.yml"), "utf8")
    const preflight = readFileSync(resolve(root, "packages/mongolgpt/script/release-preflight.ts"), "utf8")
    const localInstall = readFileSync(resolve(root, "packages/mongolgpt/script/smoke-local-npm-install.ts"), "utf8")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain('description: "npm dev tag руу нийтлэх эсэх"')
    expect(workflow).toContain("default: false")
    expect(workflow).toContain('"BUILD DEV CLI PREVIEW"')
    expect(workflow).toContain('"PUBLISH DEV CLI SDK PLUGIN UI npm dev"')
    expect(workflow).toContain("if: inputs.publish == true")
    expect(workflow).toContain("MONGOLGPT_CHANNEL: dev")
    expect(workflow).toContain("0.0.0-dev-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}")
    expect(workflow).toContain("smoke-built-cli-windows.ps1")
    expect(workflow).toContain('-ExpectedAccountUrl "https://dev.mgpt.mn"')
    expect(workflow).toContain("packages/mongolgpt/script/publish.ts --dry-run --npm-only")
    expect(workflow).toContain("packages/mongolgpt/script/smoke-local-npm-install.ts")
    expect(workflow).toContain("packages/mongolgpt/script/publish.ts --npm-only")
    for (const script of [
      "packages/sdk/js/script/publish.ts",
      "packages/plugin/script/publish.ts",
      "packages/ui/script/publish.ts",
    ]) {
      expect(workflow).toContain(`${script} --dry-run`)
      expect(workflow).toContain(`${script} --skip-build`)
    }
    expect(workflow.indexOf("script/npm-publish-access.ts")).toBeLessThan(
      workflow.indexOf("packages/mongolgpt/script/publish.ts --npm-only"),
    )
    expect(workflow).toContain("packages/mongolgpt/script/release-preflight.ts --npm")
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")
    expect(workflow).not.toContain("MONGOLGPT_RELEASE")
    expect(workflow).not.toContain("MONGOLGPT_CHANNEL: latest")
    expect(workflow).not.toContain("gh release")
    expect(workflow).not.toContain("packages/desktop")
    expect(preflight).toContain("smokePublicNpmInstall(version)")
    expect(preflight).toContain("smokePublicPlatformPackages(version)")
    expect(localInstall).toContain('"--offline"')
    expect(localInstall).toContain('"--force"')
    expect(localInstall).toContain('"mongolgpt/free-auto"')
    expect(localInstall).toContain('"mongolgpt account login"')
  })

  test("checks npm authentication and complete package ownership without publishing", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/npm-token-preflight.yml"), "utf8")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")
    expect(workflow).toContain("bun script/npm-publish-access.ts")
    expect(workflow).toContain("actions/checkout@")
    expect(workflow).toContain("./.github/actions/setup-bun")
    expect(workflow).not.toContain("run: npm publish")
    expect(workflow).not.toContain('npm publish "$package"')
  })

  test("uploads Windows and Desktop assets to the release tag created by the version job", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const canonicalUpload = 'gh release upload "${{ needs.version.outputs.tag }}"'

    expect(workflow.split(canonicalUpload).length - 1).toBe(2)
    expect(workflow).not.toContain('gh release upload "v${{ needs.version.outputs.version }}"')
    expect(workflow).not.toContain("sergei10a-rgb/mongolgpt-beta")
    expect(workflow).toContain("path: packages/desktop/dist/*.yml")
    expect(workflow).toContain("MONGOLGPT_CHANNEL: ${{ (github.ref_name == 'beta' && 'beta') || 'latest' }}")
  })

  test("uses one reusable packaged Windows desktop smoke gate", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const smoke = readFileSync(resolve(root, "packages/desktop/scripts/smoke-packaged-windows.ps1"), "utf8")

    expect(workflow).toContain("./scripts/smoke-packaged-windows.ps1")
    expect(workflow).toContain('-ExpectedVersion "${{ needs.version.outputs.version }}"')
    expect(workflow).toContain("-ExpectedProductName $expectedProductName")
    expect(workflow).not.toContain('$apps = @(Get-ChildItem -LiteralPath "dist\\win-unpacked"')
    expect(smoke).toContain('MONGOLGPT_TEST_ONBOARDING", "1"')
    expect(smoke).toContain("MONGOLGPT_DESKTOP_SMOKE_FILE")
    expect(smoke).toContain('result.url -notlike "mongolgpt-renderer://renderer/*"')
    expect(smoke).toContain("$result.version -ne $ExpectedVersion")
    expect(smoke).toContain("$versionInfo.ProductName -ne $ExpectedProductName")
    expect(smoke).toContain("WaitForExit($ExitTimeoutSeconds * 1000)")
  })

  test("uses reusable packaged and installed Windows desktop smoke gates before desktop publication", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const packagedSmoke = readFileSync(resolve(root, "packages/desktop/scripts/smoke-packaged-windows.ps1"), "utf8")
    const installedSmoke = readFileSync(resolve(root, "packages/desktop/scripts/smoke-installed-windows.ps1"), "utf8")
    const packageStep = "      - name: Package\n"
    const packageNoPublishStep = "      - name: Package (no publish)\n"
    const packagedStep = "      - name: Smoke-test packaged Windows desktop\n"
    const installedStep = "      - name: Smoke-test installed Windows desktop\n"
    const signatureStep = "      - name: Verify signed Windows Electron artifacts\n"
    const desktopArtifactStep = "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: mongolgpt-desktop-${{ matrix.settings.target }}\n"
    const latestYmlStep = "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        if: needs.version.outputs.release\n        with:\n          name: latest-yml-${{ matrix.settings.target }}\n"

    expect(workflow).toContain("./scripts/smoke-packaged-windows.ps1")
    expect(workflow).toContain("./scripts/smoke-installed-windows.ps1")
    expect(workflow).toContain('-InstallerPath "dist/mongolgpt-desktop-win-x64.exe"')
    expect(workflow).toContain('-ExpectedVersion "${{ needs.version.outputs.version }}"')
    expect(workflow).toContain("-ExpectedProductName $expectedProductName")
    expect(workflow).toContain("timeout-minutes: 8")
    expect(workflow.indexOf(packageStep)).toBeLessThan(workflow.indexOf(packagedStep))
    expect(workflow.indexOf(packageNoPublishStep)).toBeLessThan(workflow.indexOf(packagedStep))
    expect(workflow.indexOf(packagedStep)).toBeLessThan(workflow.indexOf(installedStep))
    expect(workflow.indexOf(installedStep)).toBeLessThan(workflow.indexOf(signatureStep))
    expect(workflow.indexOf(installedStep)).toBeLessThan(workflow.indexOf(desktopArtifactStep))
    expect(workflow.indexOf(installedStep)).toBeLessThan(workflow.indexOf(latestYmlStep))

    expect(installedSmoke).toContain("[string]$InstallerPath = (Join-Path $PSScriptRoot \"..\\dist\\mongolgpt-desktop-win-x64.exe\")")
    expect(installedSmoke).toContain('Start-Process `')
    expect(installedSmoke).toContain('-ArgumentList @("/S", "/D=$installRoot")')
    expect(installedSmoke).toContain('Get-ChildItem -LiteralPath $installRoot -Filter "Uninstall *.exe"')
    expect(installedSmoke).toContain('Start-Process `')
    expect(installedSmoke).toContain('-ArgumentList "/S" `')
    expect(installedSmoke).toContain('Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue')
    expect(installedSmoke).toContain('$result.accountGateVisible -ne $true')
    expect(installedSmoke).toContain('$result.accountHeading -ne "MongolGPT бүртгэлээрээ нэвтэрнэ үү"')
    expect(installedSmoke).toContain('$result.loginAction -ne "Бүртгүүлэх эсвэл нэвтрэх"')
    expect(installedSmoke).toContain('Test-Path -LiteralPath $app.FullName -PathType Leaf')
    expect(installedSmoke).toContain('Desktop uninstaller суулгасан executable-ийг арилгасангүй')
    expect(packagedSmoke).toContain('MONGOLGPT_TEST_ONBOARDING", "1"')
  })

  test("builds a guarded, checksummed Windows dev preview without publishing", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/build-dev-windows-preview.yml"), "utf8")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain('"BUILD DEV WINDOWS PREVIEW"')
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain("MONGOLGPT_CHANNEL: dev")
    expect(workflow).toContain("0.0.0-dev.$env:GITHUB_RUN_ID.$env:GITHUB_RUN_ATTEMPT")
    expect(workflow).toContain("electron-builder --win --x64 --publish never")
    expect(workflow).toContain('-ExpectedProductName "MongolGPT Dev"')
    expect(workflow).toContain("Get-FileHash -Algorithm SHA256")
    expect(workflow).toContain("SHA256SUMS.txt")
    expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(workflow).toContain("retention-days: 14")
    expect(workflow).not.toContain("gh release")
    expect(workflow).not.toContain("npm publish")
    expect(workflow).not.toContain("MONGOLGPT_CHANNEL: prod")
  })

  test("smokes the signed Windows CLI and keeps every model provider behind a MongolGPT account", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8")
    const smoke = readFileSync(resolve(root, "packages/mongolgpt/script/smoke-built-cli-windows.ps1"), "utf8")

    expect(workflow).toContain("Smoke signed Windows CLI account gate")
    expect(workflow).toContain("./script/smoke-built-cli-windows.ps1")
    expect(workflow.indexOf("Verify Windows CLI signatures")).toBeLessThan(
      workflow.indexOf("Smoke signed Windows CLI account gate"),
    )
    expect(workflow.indexOf("Smoke signed Windows CLI account gate")).toBeLessThan(
      workflow.indexOf("Repack Windows CLI archives"),
    )
    expect(workflow).toContain("account_url: ${{ steps.version.outputs.account_url }}")
    expect(workflow).toContain('-ExpectedAccountUrl "${{ needs.version.outputs.account_url }}"')
    expect(smoke).toContain('"mongolgpt/free-auto"')
    expect(smoke).toContain('"ollama/account-gate-smoke"')
    expect(smoke).toContain('@("attach", "http://127.0.0.1:1")')
    expect(smoke).toContain('"--attach"')
    expect(smoke).toContain("Test-ServerAccountGate")
    expect(smoke).toContain('@("/session", "/api/session")')
    expect(smoke).toContain('Environment["MONGOLGPT_SERVER_PASSWORD"]')
    expect(smoke).toContain("StatusCode -ne 401")
    expect(smoke).toContain('@("account", "login", "--help")')
    expect(smoke).toContain("$accountLoginHelpText.Contains($ExpectedAccountUrl)")
    expect(smoke).toContain('"MONGOLGPT_AUTH_CONTENT" = "{}"')
    expect(smoke).toContain('"MONGOLGPT_API_KEY" = ""')
    expect(smoke).toContain('@("account", "--help")')
    expect(smoke).toContain('"MongolGPT бүртгэл"')
    expect(smoke).toContain('"mongolgpt account login"')
    expect(smoke).toContain("git -C $repo init --quiet")
  })

  test("keeps installed attach entrypoints behind the remote MongolGPT workspace", () => {
    const attach = readFileSync(resolve(root, "packages/mongolgpt/src/cli/cmd/attach.ts"), "utf8")
    const run = readFileSync(resolve(root, "packages/mongolgpt/src/cli/cmd/run.ts"), "utf8")

    expect(attach).toContain("if (!InstallationLocal)")
    expect(attach).toContain("sdk.experimental.account.get()")
    expect(attach).toContain("attachedAccountReady")
    expect(run).toContain("initialAccountLoginRequired({ providerID: attachedProviderID, attached: true })")
    expect(run).toContain("attachedAccountReady")
  })

  test("bundles TypeScript workspace contracts into the Electron main process", () => {
    const desktop = JSON.parse(readFileSync(resolve(root, "packages/desktop/package.json"), "utf8"))

    for (const name of ["@mongolgpt/account-contract", "@mongolgpt/local-bridge"]) {
      expect(desktop.dependencies?.[name]).toBeUndefined()
      expect(desktop.devDependencies?.[name]).toBe("workspace:*")
    }
  })
})
