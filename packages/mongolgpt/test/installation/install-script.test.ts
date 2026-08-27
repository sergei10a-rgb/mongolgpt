import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const installScript = path.join(repoRoot, "install")
const bashExecutable =
  ["C:\\msys64\\usr\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"].find((file) => existsSync(file)) ?? "bash"

function posixify(file: string) {
  return file.replaceAll("\\", "/")
}

describe("install script", () => {
  test("downloads the Windows ARM64 CLI archive when the host reports that architecture", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mongolgpt-install-script-"))
    const fakeHome = path.join(root, "home")
    const fakeCurlLog = path.join(root, "curl.log")
    const fakeTmp = path.join(root, "tmp")

    mkdirSync(fakeHome, { recursive: true })
    mkdirSync(fakeTmp, { recursive: true })
    writeFileSync(fakeCurlLog, "")

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
      '  if [ -n "$output" ]; then : > "$output"; fi',
      '  if [[ "$*" == *"api.github.com/repos/sergei10a-rgb/mongolgpt/releases/latest"* ]]; then',
      '    printf \'{"tag_name":"mongolgpt-v9.9.9"}\'',
      "  fi",
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
      "set -- --version 1.2.3 --no-modify-path",
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
      },
      encoding: "utf8",
    })

    try {
      expect(result.status).toBe(0)
      expect(existsSync(path.join(fakeHome, ".mongolgpt", "bin", "mongolgpt.exe"))).toBe(true)
      expect(existsSync(path.join(fakeHome, ".mongolgpt", "bin", "mongolgpt"))).toBe(false)
      const curlLog = readFileSync(fakeCurlLog, "utf8")
      expect(curlLog).toContain("mongolgpt-windows-arm64.zip")
      expect(curlLog).toContain("/releases/download/mongolgpt-v1.2.3/mongolgpt-windows-arm64.zip")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
