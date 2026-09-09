import assert from "node:assert/strict"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes, randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { deriveCheckpointControlToken, sdkControlEnv, sdkControlHeader } from "@mongolgpt/runtime-auth/control"
import { verifySandboxBuild } from "./build-sandbox"
import upstream from "../vendor/sandbox-control/upstream.json"
import { summarizeCanaryLogs } from "./canary-diagnostics"
import { runtimeReadiness } from "../src/runtime"

const root = fileURLToPath(new URL("../", import.meta.url))
const executable = join(root, "../mongolgpt/dist/mongolgpt-linux-x64/bin/mongolgpt")
const script = fileURLToPath(import.meta.url)
const node = process.env.MONGOLGPT_TEST_NODE ?? Bun.which("node")
const path = `${node ? dirname(node) : "/usr/bin"}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
const baseEnv = {
  PATH: path,
  WRANGLER_SEND_METRICS: "false",
  MINIFLARE_WORKERD_PATH: process.env.MINIFLARE_WORKERD_PATH,
}

if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Linux root integration runner required")
if (!node) throw new Error("Node 22.14+ is required for local D1/R2 integration")

if (!["--isolated", "--rooted"].includes(process.argv[2]!)) {
  await verifySandboxBuild()
  assert.ok(await Bun.file(executable).exists(), "Build the current Linux CLI first")
  await mkdir(join(root, ".tmp"), { recursive: true })
  const output = await mkdtemp(join(root, ".tmp/hosted-container-"))
  const group = `/sys/fs/cgroup/mongolgpt-integration-${randomUUID()}`
  await mkdir(group, { mode: 0o700 })
  try {
    const child = Bun.spawn(
      [
        "unshare",
        "--mount",
        "--net",
        "--pid",
        "--fork",
        "--kill-child=SIGKILL",
        "--mount-proc",
        process.execPath,
        script,
        "--isolated",
        output,
        group,
      ],
      { env: { ...baseEnv, MONGOLGPT_TEST_NODE: node }, stdout: "inherit", stderr: "inherit" },
    )
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 600_000)
    try {
      process.exitCode = await child.exited
    } finally {
      clearTimeout(timer)
    }
    console.log(`Integration evidence: ${output}`)
  } finally {
    // The namespace cannot clean up host cgroup directories after SIGKILL.
    // Reap only this run's generated, dedicated subtree, never unrelated groups.
    try {
      await writeFile(join(group, "cgroup.kill"), "1")
      await until(
        async () => (await readFile(join(group, "cgroup.events"), "utf8")).includes("populated 0"),
        "Integration cgroup cleanup",
      )
      await removeGroup(group, group)
    } catch (error) {
      console.error("Integration cgroup cleanup failed", error)
      if (!process.exitCode) process.exitCode = 1
    }
  }
  if (process.exitCode === 0) {
    const proof = await Bun.file(join(output, "proof.json")).json()
    await writeFile(join(output, "result.json"), `${JSON.stringify(proof, null, 2)}\n`)
    console.log(`HOSTED_CONTAINER_RESULT ${JSON.stringify(proof)}`)
  }
} else if (process.argv[2] === "--isolated") {
  await namespace(process.argv[3]!, process.argv[4]!)
} else {
  await isolated(process.argv[3]!)
}

async function namespace(output: string, group: string) {
  assert.match(group, /^\/sys\/fs\/cgroup\/mongolgpt-integration-[0-9a-f-]{36}$/)
  await command(["mount", "--make-rprivate", "/"])
  await command(["mount", "-t", "tmpfs", "-o", "mode=1777", "tmpfs", "/tmp"])
  await chmod("/tmp", 0o1777)
  await assertMode("/tmp", 0o1777)
  await command(["ip", "link", "set", "lo", "up"])
  const jail = "/tmp/hosted-root"
  // A disposable root filesystem allows the real atomic /workspace rename.
  // System binaries are read-only; /workspace and all root-owned state are new.
  for (const directory of [
    "/bin",
    "/sbin",
    "/usr",
    "/lib",
    "/lib64",
    "/etc",
    "/dev",
    "/sys",
    "/proc",
    "/tmp",
    "/run",
    "/root",
    "/workspace",
    "/container-server",
  ])
    await mkdir(`${jail}${directory}`, { recursive: true, mode: directory === "/tmp" ? 0o1777 : 0o755 })
  await chmod(`${jail}/tmp`, 0o1777)
  await assertMode(`${jail}/tmp`, 0o1777)
  await assertMode(`${jail}/workspace`, 0o755)
  await assertMode(`${jail}/run`, 0o755)
  for (const directory of ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/sys"]) {
    await command(["mount", "--bind", directory, `${jail}${directory}`])
    await command(["mount", "-o", "remount,bind,ro", `${jail}${directory}`])
  }
  await command(["mount", "--rbind", "/dev", `${jail}/dev`])
  // Keep a real mount-root offset inside the cgroup namespace. A root mount
  // would hide regressions that confuse /sys paths with /proc membership.
  const subtree = join(group, "runtime")
  await mkdir(subtree, { mode: 0o700 })
  await command(["mount", "--bind", subtree, `${jail}/sys/fs/cgroup`])
  await command(["mount", "-t", "proc", "proc", `${jail}/proc`])
  const repo = join(root, "../..")
  await mkdir(`${jail}${repo}`, { recursive: true })
  await command(["mount", "--bind", repo, `${jail}${repo}`])
  await command(["mount", "-o", "remount,bind,ro", `${jail}${repo}`])
  await command(["mount", "--bind", output, `${jail}${output}`])
  await command(["mount", "-t", "tmpfs", "-o", "mode=0755", "tmpfs", `${jail}/usr/local/bin`])
  await copyFile("/proc/self/exe", `${jail}/usr/local/bin/bun`)
  await copyFile(node!, `${jail}/usr/local/bin/node`)
  await chmod(`${jail}/usr/local/bin/bun`, 0o555)
  await chmod(`${jail}/usr/local/bin/node`, 0o555)
  await writeFile(join(group, "cgroup.procs"), String(process.pid))
  const child = Bun.spawn(["unshare", "--cgroup", "chroot", jail, "/usr/local/bin/bun", script, "--rooted", output], {
    env: { ...baseEnv, MONGOLGPT_TEST_NODE: "/usr/local/bin/node" },
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exitCode = await child.exited
}

async function isolated(output: string) {
  await assertMode("/tmp", 0o1777)
  await assertMode("/workspace", 0o755)
  await assertMode("/run", 0o755)
  await writeFile("/tmp/hosts", "127.0.0.1 localhost checkpoint.mongolgpt.internal history.mongolgpt.internal\n")
  await command(["mount", "--bind", "/tmp/hosts", "/etc/hosts"])
  await copyFile(executable, "/usr/local/bin/mongolgpt")
  await copyFile(join(root, "container/sandbox"), "/container-server/sandbox")
  await chmod("/usr/local/bin/mongolgpt", 0o555)
  await chmod("/container-server/sandbox", 0o555)
  await command([
    "cc",
    "-Os",
    "-s",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-static",
    join(root, "container/workspace-launcher.c"),
    "-o",
    "/usr/local/bin/mongolgpt-workspace-launcher",
  ])
  await chmod("/usr/local/bin/mongolgpt-workspace-launcher", 0o555)
  const compiledVersion = (await command(["/usr/local/bin/mongolgpt", "--version"])).trim()
  assert.ok(compiledVersion)
  assert.ok(
    (await readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .some((line) => line.split(" ")[3] === "/runtime" && line.split(" ")[4] === "/sys/fs/cgroup"),
    "Compiled native proof must use a non-root cgroup mount",
  )
  const build = await Bun.build({
    entrypoints: [join(root, "test/fixtures/history-native.ts")],
    outdir: "/tmp/native",
    naming: "history-rpc.mjs",
    target: "node",
  })
  if (!build.success) throw new AggregateError(build.logs, "Native integration fixture build failed")
  const scope = { accountID: "account_container_integration", workspaceID: "workspace_container_integration" }
  const secret = randomBytes(32).toString("hex")
  const adminToken = randomBytes(32).toString("hex")
  const sdkToken = randomBytes(32).toString("hex")
  const checkpointToken = await deriveCheckpointControlToken(secret, scope)
  const password = randomBytes(32).toString("hex")
  const privateValues = [secret, adminToken, sdkToken, checkpointToken, password]
  await mkdir("/tmp/bridge", { mode: 0o700 })
  await writeFile(
    "/tmp/bridge/config.json",
    JSON.stringify({
      root: "/tmp/bridge",
      nativeBundle: "/tmp/native/history-rpc.mjs",
      port: 80,
      scope,
      secret,
      adminToken,
      dropFirstClaimResponse: true,
    }),
    { mode: 0o600 },
  )
  await mkdir("/tmp/sdk-home", { mode: 0o700 })
  const bridgeLogs = [join(output, "bridge.log"), join(output, "bridge-error.log")]
  const bridge = Bun.spawn(
    [
      node!,
      "--experimental-strip-types",
      join(root, "test/fixtures/container-checkpoint-bridge.ts"),
      "/tmp/bridge/config.json",
    ],
    {
      cwd: root,
      env: { ...baseEnv, HOME: "/tmp/bridge" },
      stdout: Bun.file(bridgeLogs[0]!),
      stderr: Bun.file(bridgeLogs[1]!),
    },
  )
  const headers = { authorization: `Basic ${Buffer.from(`mongolgpt:${password}`).toString("base64")}` }
  const controlHeaders = { [sdkControlHeader]: sdkToken }
  const adminHeaders = { "x-test-admin-token": adminToken }
  const logs = [...bridgeLogs]
  const captures: Array<{ controller: AbortController; done: Promise<void>; failure?: "unavailable" | "size_limit" }> =
    []
  let phase = "bridge_readiness"
  let outer: ReturnType<typeof Bun.spawn> | undefined
  try {
    await until(
      async () => {
        assert.equal(bridge.exitCode, null, "D1/R2 bridge exited")
        return fetch("http://127.0.0.1/__test/health", { headers: adminHeaders }).then(
          (r) => r.ok,
          () => false,
        )
      },
      "D1/R2 bridge readiness",
      90_000,
    )
    const blocked = await fetch("http://checkpoint.mongolgpt.internal/v1/bootstrap", { method: "POST", body: "{}" })
    assert.equal(blocked.status, 403, "Bridge must not bypass root checkpoint authentication")
    const initial = await json<BridgeStatus>("http://127.0.0.1/__test/status", { headers: adminHeaders })
    assert.equal(initial.epoch, 0)
    assert.equal(initial.checkpoint, null)
    assert.equal(initial.revision, null)
    assert.equal(initial.injected.archiveResponsesWithoutLength, 0)
    privateValues.push((await Bun.file("/tmp/bridge/.container-checkpoint-bridge-master.json").json()).master)
    let accepted: BridgeStatus | undefined
    const archiveDownloads = []
    const sessionID = "ses_compiled_container_restore"
    const proof = "native-r2-proof-compiled-container"
    let lostInitialClaimRecovered = false
    let replayedSameClaim = false
    const startNative = async (label: number | string) => {
      phase = "container_start"
      const stdout = join(output, `container-${label}.log`)
      const stderr = join(output, `container-${label}-error.log`)
      logs.push(stdout, stderr)
      const nativeLog = `/tmp/native-${label}.log`
      await writeFile(nativeLog, "", { mode: 0o600 })
      logs.push(nativeLog)
      const spawned = Bun.spawn(["/usr/local/bin/mongolgpt", "serve"], {
        cwd: "/",
        env: {
          PATH: path,
          HOME: "/tmp/sdk-home",
          MONGOLGPT_CONTAINER_ENTRYPOINT: "true",
          [sdkControlEnv]: sdkToken,
          SANDBOX_VERSION: upstream.version,
          PYTHON_POOL_MIN_SIZE: "0",
          TYPESCRIPT_POOL_MIN_SIZE: "0",
          SANDBOX_LOG_LEVEL: "error",
        },
        stdout: Bun.file(stdout),
        stderr: Bun.file(stderr),
      })
      outer = spawned
      await until(async () => {
        assert.equal(outer!.exitCode, null, "Compiled outer container exited before SDK readiness")
        return fetch("http://127.0.0.1:3000/api/ping", { headers: controlHeaders }).then(
          (r) => r.ok,
          () => false,
        )
      }, "SDK readiness")
      // Match Sandbox.startProcess's persistent execution session, not the
      // sessionless HTTP escape used by the older local harness.
      phase = "persistent_session_create"
      const sdkSession = `native-supervisor-${label}`
      const session = await json<{ success: boolean }>("http://127.0.0.1:3000/api/session/create", {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({ id: sdkSession, env: { [sdkControlEnv]: sdkToken }, cwd: "/workspace" }),
      })
      assert.equal(session.success, true, "Native SDK execution session was not created")
      phase = "native_process_start"
      await json("http://127.0.0.1:3000/api/process/start", {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({
          command: "/usr/local/bin/mongolgpt serve --hostname 0.0.0.0 --port 4096",
          processId: "mongolgpt-server",
          sessionId: sdkSession,
          cwd: "/workspace",
          env: {
            HOME: "/workspace",
            XDG_DATA_HOME: "/workspace/.mongolgpt/data",
            XDG_CONFIG_HOME: "/workspace/.mongolgpt/config",
            XDG_CACHE_HOME: "/workspace/.mongolgpt/cache",
            XDG_STATE_HOME: "/workspace/.mongolgpt/state",
            MONGOLGPT_DB: "/workspace/.mongolgpt/runtime.sqlite",
            MONGOLGPT_SERVER_USERNAME: "mongolgpt",
            MONGOLGPT_SERVER_PASSWORD: password,
            MONGOLGPT_DISABLE_SHARE: "true",
            MONGOLGPT_AUTO_SHARE: "false",
            MONGOLGPT_RUNTIME_MODE: "hosted",
            MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
            MONGOLGPT_CONSOLE_URL: "http://console.invalid",
            MONGOLGPT_API_KEY: "runtime",
            MONGOLGPT_CLOUD_HISTORY: "true",
            MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
            MONGOLGPT_RUNTIME_SUPERVISOR: "true",
            MONGOLGPT_CHECKPOINT_CONTROL_TOKEN: checkpointToken,
          },
        }),
      })
      phase = "sdk_log_capture"
      const controller = new AbortController()
      const timer = globalThis.setTimeout(() => controller.abort(), 8000)
      const response = await fetch("http://127.0.0.1:3000/api/process/mongolgpt-server/stream", {
        headers: controlHeaders,
        redirect: "error",
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
      assert.equal(response.status, 200, "SDK log stream must be available")
      assert.ok(response.body, "SDK log stream must have a body")
      const file = await open(nativeLog, "w", 0o600)
      const capture: (typeof captures)[number] = { controller, done: Promise.resolve() }
      captures.push(capture)
      let bytes = 0
      // Observe the real FIFO-backed SDK stream; never redirect the native command.
      capture.done = response.body
        .pipeTo(
          new WritableStream<Uint8Array>({
            async write(chunk) {
              bytes += chunk.byteLength
              if (bytes > 1024 * 1024) {
                capture.failure = "size_limit"
                throw new Error("SDK log capture size limit")
              }
              await file.writeFile(chunk).catch(() => {
                capture.failure = "unavailable"
                throw new Error("SDK log capture write failed")
              })
            },
          }),
          { signal: controller.signal },
        )
        .catch(async () => {
          // SDK shutdown can close the HTTP stream before the outer exit event.
          if (!controller.signal.aborted) await Promise.race([spawned.exited, setTimeout(1000)])
          if (!controller.signal.aborted && spawned.exitCode === null) capture.failure ??= "unavailable"
        })
        .finally(() =>
          file.close().catch(() => {
            capture.failure ??= "unavailable"
          }),
        )
      return { capture, outer: spawned }
    }
    assert.deepEqual(await readdir("/workspace"), [], "Initial startup must begin from physically empty workspace")
    const initialRuntimeEntries = await readdir("/run")
    assert.deepEqual(
      initialRuntimeEntries.filter((entry) => entry !== "mount"),
      [],
      "Initial startup must begin from physically empty runtime state",
    )
    assert.equal(await Bun.file("/run/mongolgpt-container/control.sock").exists(), false)
    const failedAttempt = await startNative("lost-initial-claim")
    phase = "lost_initial_claim_shutdown"
    await until(
      async () => {
        const response = await fetch("http://127.0.0.1:4096/global/health", {
          headers,
          signal: AbortSignal.timeout(1000),
        }).catch(() => undefined)
        assert.notEqual(response?.ok, true, "Dropped initial claim response must not admit native HTTP")
        return failedAttempt.outer.exitCode !== null
      },
      "Dropped initial claim response shutdown",
      180_000,
    )
    assert.notEqual(
      await terminal(failedAttempt.outer, 20_000),
      0,
      "Controller must fail closed after lost initial claim response",
    )
    await finishCapture(failedAttempt.capture)
    outer = undefined
    const lostClaimStatus = await json<BridgeStatus>("http://127.0.0.1/__test/status", { headers: adminHeaders })
    assert.equal(lostClaimStatus.injected.droppedClaimResponses, 1)
    const firstClaims = lostClaimStatus.historyRequests.filter((entry) => entry.path === "/v1/claim")
    assert.equal(firstClaims.length, 1)
    assert.ok(firstClaims[0]!.claim, "Dropped claim response must record safe claim metadata")
    assert.equal(
      lostClaimStatus.epoch,
      firstClaims[0]!.claim!.expectedEpoch + 1,
      "Dropped claim response must still commit the D1 writer epoch",
    )
    assert.equal(lostClaimStatus.historyRequests.at(-1)?.injected, "dropped_first_claim_response")
    for (const round of [1, 2]) {
      if (round === 1) {
        assert.notDeepEqual(await readdir("/workspace"), [], "Retry must preserve the failed startup workspace")
        assert.notDeepEqual(
          (await readdir("/run")).filter((entry) => entry !== "mount"),
          [],
          "Retry must preserve the failed startup runtime state",
        )
      } else {
        assert.deepEqual(await readdir("/workspace"), [], "Replacement must start from physically empty workspace")
        const runtimeEntries = await readdir("/run")
        assert.deepEqual(runtimeEntries, [], "Replacement must start from physically empty runtime state")
        assert.equal(await Bun.file("/run/mongolgpt-container/control.sock").exists(), false)
      }
      const before = await json<BridgeStatus>("http://127.0.0.1/__test/status", { headers: adminHeaders })
      const archive200Before = before.requestPathStatusCounters["/v1/archive"]?.["200"] ?? 0
      const attempt = await startNative(round)
      phase = `round_${round}_native_readiness`
      await until(
        async () => {
          assert.equal(attempt.outer.exitCode, null, "Outer container exited during native startup")
          const state = await json<{ process: { status: string } }>(
            "http://127.0.0.1:3000/api/process/mongolgpt-server",
            { headers: controlHeaders },
          )
          assert.ok(["starting", "running"].includes(state.process.status), `Native process ${state.process.status}`)
          const response = await fetch("http://127.0.0.1:4096/global/health", {
            headers,
            signal: AbortSignal.timeout(4000),
          }).catch(() => undefined)
          if (!response?.ok) return false
          assert.match(response.headers.get("content-type") ?? "", /application\/json/)
          const health = (await response.json()) as { healthy: boolean; version: string }
          assert.equal(health.healthy, true)
          assert.equal(health.version, compiledVersion)
          assert.equal(response.headers.get("x-mongolgpt-runtime-history"), "checkpoint-v1")
          assert.equal(response.headers.get("x-mongolgpt-runtime-isolation"), "cgroup-v1")
          assert.equal(response.headers.get("x-mongolgpt-runtime-publication"), "tool-pty-v1")
          assert.deepEqual(
            await runtimeReadiness(
              {
                containerFetch(request, port) {
                  const target = new URL(request.url)
                  target.hostname = "127.0.0.1"
                  target.port = String(port)
                  return fetch(new Request(target, request))
                },
              },
              password,
              true,
            ),
            { code: "ready", status: 200 },
          )
          return true
        },
        "Native checkpoint/isolation/publication readiness",
        180_000,
      )
      console.log(`Round ${round}: compiled native runtime admitted with durable/isolation receipts`)
      phase = `round_${round}_restore_and_publication`
      if (round === 1) {
        const retryStatus = await json<BridgeStatus>("http://127.0.0.1/__test/status", { headers: adminHeaders })
        const claims = retryStatus.historyRequests.filter((entry) => entry.path === "/v1/claim")
        assert.equal(claims.length, 2, "Retry must replay exactly one pending claim")
        assert.deepEqual(claims[1]!.claim, claims[0]!.claim, "Retry claim must reuse exact safe claim metadata")
        assert.equal(claims[0]!.claim?.hasCheckpointID, true)
        assert.equal(claims[0]!.claim?.hasFilesRevisionID, false)
        assert.equal(retryStatus.epoch, lostClaimStatus.epoch, "Retry must not advance a new writer epoch")
        assert.equal(retryStatus.injected.droppedClaimResponses, 1)
        assert.equal(
          retryStatus.requestPathStatusCounters["/v1/epoch"]?.["200"] ?? 0,
          lostClaimStatus.requestPathStatusCounters["/v1/epoch"]?.["200"] ?? 0,
          "Pending retry must not issue another epoch read",
        )
        lostInitialClaimRecovered = true
        replayedSameClaim = true
      }
      if (round === 1) {
        const session = await json<{ data: { id: string } }>("http://127.0.0.1:4096/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: sessionID, location: { directory: "/workspace" } }),
        })
        assert.equal(session.data.id, sessionID)
        const pty = await json<{ data: { id: string } }>(
          "http://127.0.0.1:4096/api/pty?location[directory]=/workspace",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              command: "/bin/sh",
              args: [
                "-c",
                `test "$(id -u)" = 10001 && test -z "$MONGOLGPT_SDK_CONTROL_TOKEN" && test -z "$MONGOLGPT_CHECKPOINT_CONTROL_TOKEN" && mkdir -p /workspace/audit-proof && printf '%s' '${proof}' > /workspace/audit-proof/proof.txt`,
              ],
              cwd: "/workspace",
              title: "Persistence integration",
            }),
          },
        )
        assert.match(pty.data.id, /^pty/)
        await until(
          async () => {
            const value = await json<{ data: { status: string; exitCode?: number } }>(
              `http://127.0.0.1:4096/api/pty/${pty.data.id}?location[directory]=/workspace`,
              { headers },
            )
            if (value.data.status !== "exited") return false
            assert.equal(value.data.exitCode, 0)
            return true
          },
          "Real PTY file publication",
          90_000,
        )
      }
      const session = await json<{ data: { id: string } }>(`http://127.0.0.1:4096/api/session/${sessionID}`, {
        headers,
      })
      assert.equal(session.data.id, sessionID)
      const file = await json<{ type: string; content: string }>(
        "http://127.0.0.1:4096/file/content?path=audit-proof/proof.txt&directory=/workspace",
        { headers },
      )
      assert.equal(file.type, "text")
      assert.equal(file.content, proof)
      assert.equal(await readFile("/workspace/audit-proof/proof.txt", "utf8"), proof)
      const status = await json<BridgeStatus>("http://127.0.0.1/__test/status", { headers: adminHeaders })
      assert.ok(status.checkpoint)
      assert.ok(status.revision)
      if (accepted) {
        assert.equal(status.epoch, accepted.epoch + 1, "Replacement must claim a new writer epoch")
        assert.match(status.checkpoint.data.id, /^[0-9a-f-]{36}$/)
        assert.equal(status.checkpoint.data.id, accepted.checkpoint!.data.id)
        assert.ok(
          (status.requestPathStatusCounters["/v1/archive"]?.["200"] ?? 0) -
            (accepted.requestPathStatusCounters["/v1/archive"]?.["200"] ?? 0) >=
            2,
          "Fresh replacement must download authenticated archives",
        )
      }
      archiveDownloads.push({
        round,
        downloads: (status.requestPathStatusCounters["/v1/archive"]?.["200"] ?? 0) - archive200Before,
        withoutContentLength:
          status.injected.archiveResponsesWithoutLength - before.injected.archiveResponsesWithoutLength,
      })
      phase = `round_${round}_archive_transport`
      assert.equal(
        archiveDownloads.at(-1)!.withoutContentLength,
        archiveDownloads.at(-1)!.downloads,
        "Every successful archive download must finish without Content-Length",
      )
      const runningOuter = attempt.outer
      phase = `round_${round}_graceful_exit`
      runningOuter.kill("SIGTERM")
      assert.equal(
        await terminal(runningOuter, 260_000),
        0,
        "Container must acknowledge final durable publication before stopping SDK",
      )
      await finishCapture(attempt.capture)
      outer = undefined
      accepted = await json<BridgeStatus>("http://127.0.0.1/__test/status", { headers: adminHeaders })
      assert.ok(
        accepted.revision!.data.sequence > status.revision.data.sequence,
        "Shutdown must publish another acknowledged revision",
      )
      assert.equal(
        await fetch("http://127.0.0.1:3000/api/ping").then(
          () => true,
          () => false,
        ),
        false,
      )
      if (round === 1) {
        await mkdir("/tmp/retired", { mode: 0o700 })
        for (const directory of ["/workspace", "/run"]) {
          await rename(directory, `/tmp/retired${directory}`)
          await mkdir(directory, { mode: 0o755 })
          assert.deepEqual(await readdir(directory), [], `${directory} reset must be physically empty`)
        }
        assert.notDeepEqual(await readdir("/tmp/retired/workspace"), [])
        assert.notDeepEqual(await readdir("/tmp/retired/run"), [])
      }
    }
    assert.ok(
      archiveDownloads[1]!.downloads >= 2,
      "Second physical replacement must fetch checkpoint and revision archives",
    )
    assert.ok(
      archiveDownloads[1]!.withoutContentLength >= 2,
      "Second physical replacement must restore both archives without Content-Length",
    )
    phase = "captured_log_secret_scan"
    for (const log of logs) {
      const content = await readFile(log, "utf8")
      for (const value of privateValues)
        assert.equal(content.includes(value), false, "Control secrets must not be logged")
    }
    const result = {
      ok: true,
      compiledVersion,
      cliSha256: await digest(executable),
      sdkSha256: await digest(join(root, "container/sandbox")),
      epoch: accepted!.epoch,
      realPTY: true,
      freshPhysicalWorkspace: true,
      freshPhysicalRun: true,
      archiveDownloads,
      archiveResponsesWithoutLength: accepted!.injected.archiveResponsesWithoutLength,
      lostInitialClaimRecovered,
      replayedSameClaim,
      sessionRestored: true,
      fileRestored: true,
      gracefulContainerExit: true,
      sdkFifoOutput: true,
      mappedCgroupRoot: true,
    }
    await writeFile(join(output, "proof.json"), `${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    await setTimeout(1000)
    const nativeLogRoot = "/workspace/.mongolgpt/data/mongolgpt/log"
    for (const entry of (await readdir(nativeLogRoot).catch(() => [])).slice(0, 8)) {
      if (entry.endsWith(".log")) logs.push(join(nativeLogRoot, entry))
    }
    const diagnostic = await json<BridgeStatus>("http://127.0.0.1/__test/status", {
      headers: adminHeaders,
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined)
    const summaries = []
    for (const log of logs.slice(0, 16)) {
      const file = await open(log, "r").catch(() => undefined)
      if (!file) continue
      try {
        const buffer = Buffer.alloc(65_536)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        summaries.push(summarizeCanaryLogs(buffer.subarray(0, bytesRead).toString("utf8"), ""))
      } finally {
        await file.close()
      }
    }
    console.error(
      "HOSTED_CONTAINER_FAILURE",
      JSON.stringify({
        phase,
        epoch: diagnostic?.epoch,
        checkpointPresent: !!diagnostic?.checkpoint,
        revisionPresent: !!diagnostic?.revision,
        errorSignals: summarizeCanaryLogs(error instanceof Error ? error.message : "", "").signals,
        captures: captures.map((capture) => capture.failure ?? null),
        logs: summaries,
      }),
    )
    throw new Error(`Hosted container integration failed at ${phase}`)
  } finally {
    for (const capture of captures) capture.controller.abort()
    await Promise.race([Promise.all(captures.map((capture) => capture.done)), setTimeout(3000)])
    if (outer?.exitCode === null) {
      outer.kill("SIGTERM")
      await terminal(outer, 20_000)
    }
    if (bridge.exitCode === null) bridge.kill("SIGTERM")
    await terminal(bridge, 20_000)
  }
}

async function finishCapture(capture: { controller: AbortController; done: Promise<void>; failure?: string }) {
  await Promise.race([capture.done, setTimeout(1000)])
  capture.controller.abort()
  const finished = await Promise.race([capture.done.then(() => true), setTimeout(3000).then(() => false)])
  assert.equal(finished, true, "SDK log capture cleanup deadline")
  assert.equal(capture.failure, undefined, "SDK captured output must remain available for the secret scan")
}

type BridgeStatus = {
  epoch: number
  checkpoint: { data: { id: string }; digest: string } | null
  revision: { data: { id: string; sequence: number }; digest: string } | null
  injected: { droppedClaimResponses: number; archiveResponsesWithoutLength: number }
  historyRequests: Array<{
    path: string
    status: number
    injected?: "dropped_first_claim_response"
    claim?: {
      expectedEpoch: number
      writerHash: string
      checkpointHash: string | null
      filesRevisionHash: string | null
      hasCheckpointID: boolean
      hasFilesRevisionID: boolean
    }
  }>
  requestPathStatusCounters: Record<string, Record<string, number>>
}

async function json<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(90_000),
  })
  assert.equal(
    response.status,
    200,
    `${new URL(url).pathname} returned ${response.status}: ${(await response.clone().text()).slice(0, 2000)}`,
  )
  assert.match(response.headers.get("content-type") ?? "", /application\/json/)
  return response.json() as Promise<T>
}

async function until(check: () => Promise<boolean>, name: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${name} timed out`)
    await setTimeout(100)
  }
}

async function terminal(child: ReturnType<typeof Bun.spawn>, timeout: number) {
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), timeout)
  try {
    return await child.exited
  } finally {
    clearTimeout(timer)
  }
}

async function command(args: string[]) {
  const child = Bun.spawn(args, { env: baseEnv, stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  assert.equal(await child.exited, 0, `${args[0]}: ${await stderr}`)
  return await stdout
}

async function digest(file: string) {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
}

async function assertMode(file: string, mode: number) {
  assert.equal((await lstat(file)).mode & 0o7777, mode, `${file} must have mode ${mode.toString(8)}`)
}

async function removeGroup(directory: string, root: string) {
  assert.ok(directory === root || directory.startsWith(`${root}/`))
  assert.equal(await realpath(directory), directory)
  const info = await lstat(directory)
  assert.ok(info.isDirectory() && !info.isSymbolicLink())
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    assert.ok(entry.name !== "." && entry.name !== ".." && /^[A-Za-z0-9_.-]+$/.test(entry.name))
    await removeGroup(join(directory, entry.name), root)
  }
  await rmdir(directory)
}
