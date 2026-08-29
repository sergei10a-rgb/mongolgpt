const { writeFileSync } = require("node:fs")

const modulePath = process.argv[2]
const proofPath = process.argv[3]
const marker = "MONGOLGPT_PACKAGED_PTY_OK"

if (!modulePath || !proofPath) {
  process.stderr.write("PTY module path and proof path are required\n")
  process.exit(2)
}

const pty = require(modulePath)
let output = ""
let settled = false
const terminal = pty.spawn(
  "powershell.exe",
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Write-Output ${marker}`],
  {
    name: "xterm-256color",
    cwd: process.cwd(),
    env: process.env,
    useConptyDll: true,
  },
)

const timeout = setTimeout(() => {
  if (settled) return
  settled = true
  terminal.kill()
  process.stderr.write("Packaged PTY probe timed out\n")
  process.exit(1)
}, 20_000)

terminal.onData((value) => {
  output += value
})
terminal.onExit(({ exitCode }) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  process.stdout.write(output)
  if (exitCode !== 0 || !output.includes(marker)) process.exit(1)
  writeFileSync(proofPath, `${marker}\n`, { encoding: "utf8", mode: 0o600 })
  process.exit(0)
})
