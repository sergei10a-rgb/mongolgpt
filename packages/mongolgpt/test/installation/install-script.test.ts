import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const installScript = path.join(repoRoot, "install")
const bashExecutable =
  ["C:\\msys64\\usr\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"].find((file) => existsSync(file)) ?? "bash"

function posixify(file: string) {
  return file.replaceAll("\\", "/")
}

const emptySha256 = createHash("sha256").update("").digest("hex")

function runInstallScript(input: { args?: string[]; shellSnippets?: string[]; env?: Record<string, string> }) {
  const root = mkdtempSync(path.join(tmpdir(), "mongolgpt-install-script-"))
  const fakeHome = path.join(root, "home")
  const fakeCurlLog = path.join(root, "curl.log")
  const fakeTmp = path.join(root, "tmp")

  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(fakeTmp, { recursive: true })
  writeFileSync(fakeCurlLog, "")

  const argv = input.args ?? ["--version", "1.2.3", "--no-modify-path"]
  const shellScript = [
    "uname() {",
    '  if [ "$1" = "-s" ]; then printf "%s\\n" "MINGW64_NT-10.0"; return 0; fi',
    '  if [ "$1" = "-m" ]; then printf "%s\\n" "aarch64"; return 0; fi',
    '  command uname "$@"',
    "}",
    "curl() {",
    '  printf "%s\\n" "$*" >> "$FAKE_CURL_LOG"',
    '  if [[ " $* " == *" -sI "* ]]; then printf "200"; return 0; fi',
    '  local output=""',
    '  local previous=""',
    '  for arg in "$@"; do',
    '    if [ "$previous" = "-o" ]; then output="$arg"; break; fi',
    '    previous="$arg"',
    "  done",
    '  if [ -z "$output" ]; then',
    '    if [[ "$*" == *"api.github.com/repos/sergei10a-rgb/mongolgpt/releases/latest"* ]]; then',
    '      printf \'{"tag_name":"mongolgpt-v9.9.9"}\'',
    "    fi",
    "    return 0",
    "  fi",
    '  case "$output" in',
    "    */SHA256SUMS)",
    '      if [ "${FAKE_FAIL_CHECKSUM_DOWNLOAD:-0}" = "1" ]; then return 22; fi',
    '      printf "%s\\n" "$FAKE_CHECKSUM_CONTENT" > "$output"',
    "      ;;",
    "    *)",
    '      : > "$output"',
    "      ;;",
    "  esac",
    "}",
    "unzip() {",
    '  local dest=""',
    '  local previous=""',
    '  for arg in "$@"; do',
    '    if [ "$previous" = "-d" ]; then dest="$arg"; break; fi',
    '    previous="$arg"',
    "  done",
    '  mkdir -p "$dest"',
    "  cat <<'EOF' > \"$dest/mongolgpt.exe\"",
    "#!/usr/bin/env bash",
    "echo 0.0.0-test",
    "EOF",
    '  chmod 755 "$dest/mongolgpt.exe"',
    "}",
    'sha256sum() { printf "%s  %s\\n" "$FAKE_SHA256" "$1"; }',
    ...(input.shellSnippets ?? []),
    `set -- ${argv.map((value) => `"${value}"`).join(" ")}`,
    `source "${posixify(installScript)}"`,
  ].join("\n")

  const result = spawnSync(bashExecutable, ["-lc", shellScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: posixify(fakeHome),
      SHELL: "/bin/bash",
      TMPDIR: posixify(fakeTmp),
      FAKE_CURL_LOG: posixify(fakeCurlLog),
      FAKE_CHECKSUM_CONTENT: `${input.env?.FAKE_CHECKSUM_CONTENT ?? `${emptySha256}  mongolgpt-windows-arm64.zip`}`,
      FAKE_SHA256: input.env?.FAKE_SHA256 ?? emptySha256,
      ...input.env,
    },
    encoding: "utf8",
  })

  return { result, root, fakeHome, fakeCurlLog }
}

describe("install script", () => {
  test("downloads the Windows ARM64 CLI archive when the host reports that architecture", () => {
    const { result, root, fakeHome, fakeCurlLog } = runInstallScript({})

    try {
      expect(result.status).toBe(0)
      expect(existsSync(path.join(fakeHome, ".mongolgpt", "bin", "mongolgpt.exe"))).toBe(true)
      expect(existsSync(path.join(fakeHome, ".mongolgpt", "bin", "mongolgpt"))).toBe(false)
      const curlLog = readFileSync(fakeCurlLog, "utf8")
      expect(curlLog).toContain("mongolgpt-windows-arm64.zip")
      expect(curlLog).toContain("/releases/download/mongolgpt-v1.2.3/mongolgpt-windows-arm64.zip")
      expect(curlLog).toContain("/releases/download/mongolgpt-v1.2.3/SHA256SUMS")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("pins the latest archive and checksum to the same resolved release tag", () => {
    const { result, root, fakeCurlLog } = runInstallScript({ args: ["--no-modify-path"] })

    try {
      expect(result.status).toBe(0)
      const curlLog = readFileSync(fakeCurlLog, "utf8")
      expect(curlLog).toContain("/releases/download/mongolgpt-v9.9.9/mongolgpt-windows-arm64.zip")
      expect(curlLog).toContain("/releases/download/mongolgpt-v9.9.9/SHA256SUMS")
      expect(curlLog).not.toContain("/releases/latest/download/")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when the release checksum entry for the archive is missing", () => {
    const { result, root } = runInstallScript({
      env: {
        FAKE_CHECKSUM_CONTENT: `${emptySha256}  mongolgpt-windows-x64.zip`,
      },
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("архивын checksum бичлэг release дотор алга")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("matches the exact archive basename and rejects regex-like near matches", () => {
    const { result, root } = runInstallScript({
      env: {
        FAKE_CHECKSUM_CONTENT: `${emptySha256}  mongolgpt-windows-arm64Xzip`,
      },
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("архивын checksum бичлэг release дотор алга")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when the archive has duplicate checksum entries", () => {
    const { result, root } = runInstallScript({
      env: {
        FAKE_CHECKSUM_CONTENT: [
          `${emptySha256}  mongolgpt-windows-arm64.zip`,
          `${"f".repeat(64)}  mongolgpt-windows-arm64.zip`,
        ].join("\n"),
      },
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("checksum бичлэг тодорхой бус")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when the release checksum asset cannot be downloaded", () => {
    const { result, root, fakeHome } = runInstallScript({
      env: {
        FAKE_FAIL_CHECKSUM_DOWNLOAD: "1",
      },
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("Release checksum файлыг татаж чадсангүй")
      expect(existsSync(path.join(fakeHome, ".mongolgpt", "bin", "mongolgpt.exe"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("uses the pinned v0.1.1 digest when that legacy release has no checksum asset", () => {
    const legacyDigest = "43da990f7ed71e6fbda5c910125126207e54536a29435c138f56dd55a6a62b75"
    const { result, root, fakeHome } = runInstallScript({
      args: ["--version", "0.1.1", "--no-modify-path"],
      env: {
        FAKE_FAIL_CHECKSUM_DOWNLOAD: "1",
        FAKE_SHA256: legacyDigest,
      },
    })

    try {
      expect(result.status).toBe(0)
      expect(existsSync(path.join(fakeHome, ".mongolgpt", "bin", "mongolgpt.exe"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed versions before making a release request", () => {
    const { result, root, fakeCurlLog } = runInstallScript({
      args: ["--version", "1.2.3/../../other", "--no-modify-path"],
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("Хувилбарын формат буруу")
      expect(readFileSync(fakeCurlLog, "utf8")).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when the downloaded archive hash does not match SHA256SUMS", () => {
    const { result, root } = runInstallScript({
      env: {
        FAKE_SHA256: "f".repeat(64),
      },
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("checksum release дээрх SHA256SUMS-тэй таарахгүй")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when no supported checksum verifier is available", () => {
    const { result, root } = runInstallScript({
      shellSnippets: [
        "unset -f sha256sum",
        "function command() {",
        '  if [ "$1" = "-v" ]; then',
        '    case "${2:-}" in',
        "      sha256sum|shasum|openssl|certutil|certutil.exe) return 1 ;;",
        "    esac",
        "  fi",
        '  builtin command "$@"',
        "}",
      ],
    })

    try {
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("SHA-256 баталгаажуулах хэрэгсэл олдсонгүй")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
