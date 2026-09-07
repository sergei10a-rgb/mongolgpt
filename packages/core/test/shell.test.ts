import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Shell } from "@mongolgpt/core/shell"
import { FSUtil } from "@mongolgpt/core/fs-util"
import { which } from "@mongolgpt/core/util/which"

const TEST_TIMEOUT_MS = 10_000

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const subprocessShells = () => {
  const shells = [process.platform === "win32" ? Shell.gitbash() : which("bash"), which("zsh")].filter(
    (shell): shell is string => Boolean(shell),
  )

  return Array.from(new Set(shells)).map((shell) => ({
    name: Shell.name(shell),
    path: shell,
  }))
}

const shellRcFile = (shellName: string) => {
  if (shellName === "bash") return ".bashrc"
  if (shellName === "zsh") return ".zshrc"
}

const withSubprocessFixture = async (
  shellName: string,
  fn: (fixture: { cwd: string; home: string }) => Promise<void>,
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mongolgpt-shell-"))
  const cwd = path.join(root, "cwd spaces $() `semi; [brackets]")
  const home = path.join(root, "home")
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(path.join(cwd, "marker file.txt"), "ok")

  const rc = shellRcFile(shellName)
  if (rc) {
    if (shellName === "bash") {
      await writeFile(path.join(home, ".bash_profile"), "")
    }
    await writeFile(
      path.join(home, rc),
      [
        "set -- rc modified positional args",
        "alias rc_alias='printf \"alias:ok\\n\"'",
        "export MONGOLGPT_SHELL_RC=loaded",
      ].join("\n"),
    )
  }

  try {
    await fn({ cwd, home })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runWithShellArgs = async (
  shell: string,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> => {
  const child = spawn(shell, Shell.args(shell, command, cwd), {
    cwd: process.cwd(),
    env,
    windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  let exited = false
  let timedOut = false
  child.stdout?.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
  })

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true
      void Shell.killTree(child, { exited: () => exited })
    }, TEST_TIMEOUT_MS)

    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      exited = true
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout: stdout.replace(/\r\n/g, "\n"),
        stderr: stderr.replace(/\r\n/g, "\n"),
        timedOut,
      })
    })
  })
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("mongolgpt-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("mongolgpt-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-2)).toBe("/tmp")
    expect(zsh.at(-1)).toBe("echo hi")
  })

  for (const shell of subprocessShells()) {
    test(
      `${shell.name} preserves commands through subprocess execution`,
      async () => {
        await withSubprocessFixture(shell.name, async ({ cwd, home }) => {
          const cwdName = path.basename(cwd)
          const env = { ...process.env, HOME: home, ZDOTDIR: home }
          const result = await runWithShellArgs(
            shell.path,
            [
              "printf 'quotes:%s:%s\\n' 'single quoted data' \"double quoted data\"",
              "printf 'literal:%s\\n' '$(printf bad)`printf bad`'",
              "cat <<'EOF'",
              "heredoc:$HOME",
              "heredoc:`printf bad`",
              "EOF",
              "printf 'unicode:%s\\n' 'Монгол ☃'",
              "test -f './marker file.txt' && printf 'marker:ok\\n'",
              "side='./sub count.txt'",
              'rm -f "$side"',
              'printf \'subst:%s\\n\' "$(printf x >> "$side"; basename "$PWD")"',
              "printf 'count:%s\\n' \"$(wc -c < \"$side\" | tr -d ' ')\"",
              "rc_alias",
              "printf 'rc:%s\\n' \"$MONGOLGPT_SHELL_RC\"",
            ].join("\n"),
            cwd,
            env,
          )

          expect(result.timedOut).toBe(false)
          expect(result.code).toBe(0)
          expect(result.stderr).toBe("")
          expect(result.stdout).toBe(
            [
              "quotes:single quoted data:double quoted data",
              "literal:$(printf bad)`printf bad`",
              "heredoc:$HOME",
              "heredoc:`printf bad`",
              "unicode:Монгол ☃",
              "marker:ok",
              `subst:${cwdName}`,
              "count:1",
              "alias:ok",
              "rc:loaded",
              "",
            ].join("\n"),
          )
        })
      },
      TEST_TIMEOUT_MS + 5_000,
    )

    test(
      `${shell.name} preserves command exit code`,
      async () => {
        await withSubprocessFixture(shell.name, async ({ cwd, home }) => {
          const result = await runWithShellArgs(shell.path, "printf 'before-exit\\n'\nexit 7", cwd, {
            ...process.env,
            HOME: home,
            ZDOTDIR: home,
          })

          expect(result.timedOut).toBe(false)
          expect(result.code).toBe(7)
          expect(result.stdout).toBe("before-exit\n")
        })
      },
      TEST_TIMEOUT_MS + 5_000,
    )

    test(
      `${shell.name} does not execute commands when cwd is missing`,
      async () => {
        await withSubprocessFixture(shell.name, async ({ cwd, home }) => {
          const result = await runWithShellArgs(shell.path, "printf 'should-not-run\\n'", path.join(cwd, "missing"), {
            ...process.env,
            HOME: home,
            ZDOTDIR: home,
          })

          expect(result.timedOut).toBe(false)
          expect(result.code).not.toBe(0)
          expect(result.stdout).toBe("")
        })
      },
      TEST_TIMEOUT_MS + 5_000,
    )
  }

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
