import assert from "node:assert/strict"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout } from "node:timers/promises"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { deriveControlToken, sdkControlEnv, sdkControlHeader } from "@mongolgpt/runtime-auth/control"
import upstream from "../vendor/sandbox-control/upstream.json"
import { verifySandboxBuild } from "./build-sandbox"

const root = fileURLToPath(new URL("../", import.meta.url))
const binary = `${root}container/sandbox`
const bun = process.execPath
const node = process.argv[3] ?? process.env.MONGOLGPT_TEST_NODE ?? Bun.which("node")
const toolEnv = {
  ...(process.env.ESBUILD_BINARY_PATH && { ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH }),
  ...(process.env.MINIFLARE_WORKERD_PATH && { MINIFLARE_WORKERD_PATH: process.env.MINIFLARE_WORKERD_PATH }),
}
if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Linux root integration runner required")
if (!node) throw new Error("Node 22 is required for the local Workers integration")

if (process.argv[2] !== "--isolated") {
  // No host network, host /tmp, or host process table is exposed to the SDK probe.
  const child = Bun.spawn(
    [
      "unshare",
      "--mount",
      "--net",
      "--pid",
      "--fork",
      "--mount-proc",
      "sh",
      "-eu",
      "-c",
      'mount --make-rprivate /; mount -t tmpfs -o mode=1777 tmpfs /tmp; mount -t tmpfs -o mode=0755 tmpfs /run; ip link set lo up; exec "$1" "$2" --isolated "$3"',
      "sandbox-control-test",
      bun,
      fileURLToPath(import.meta.url),
      node,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", BUN_BE_BUN: "1", ...toolEnv },
    },
  )
  process.exitCode = await child.exited
} else {
  await testControl()
}

async function testControl() {
  await verifySandboxBuild()
  const receipt = await Bun.file(`${root}container/sandbox-build.json`).json()
  assert.equal(receipt.revision, upstream.revision)
  assert.equal(receipt.bun, Bun.version)
  assert.equal(receipt.patchSha256, await hash(`${root}vendor/sandbox-control/control-auth.patch`))
  assert.equal(receipt.binarySha256, await hash(binary))
  const directory = "/tmp/sdk-home"
  await mkdir(directory, { mode: 0o755 })
  await copyFile("/proc/self/exe", "/tmp/tenant-bun")
  await chmod("/tmp/tenant-bun", 0o555)
  const env = {
    HOME: directory,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PYTHON_POOL_MIN_SIZE: "0",
    TYPESCRIPT_POOL_MIN_SIZE: "0",
    SANDBOX_LOG_LEVEL: "warn",
  }
  for (const value of [undefined, "invalid", `${"a".repeat(64)}\n`]) {
    const child = Bun.spawn([binary], {
      cwd: directory,
      env: { ...env, [sdkControlEnv]: value },
      stdout: "ignore",
      stderr: "ignore",
    })
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000)
    try {
      assert.equal(await child.exited, 1, "SDK must refuse startup without a valid control credential")
    } finally {
      clearTimeout(timer)
    }
  }
  const runtimeSecret = randomBytes(32).toString("hex")
  const token = await deriveControlToken(runtimeSecret, "control-probe-sandbox", "sdk")
  const sdk = Bun.spawn([binary], {
    cwd: directory,
    env: { ...env, [sdkControlEnv]: token },
    stdout: Bun.file("/tmp/sdk.log"),
    stderr: Bun.file("/tmp/sdk-error.log"),
  })
  try {
    const deadline = Date.now() + 30_000
    while (
      !(await fetch("http://127.0.0.1:3000/api/ping").then(
        () => true,
        () => false,
      ))
    ) {
      assert.equal(sdk.exitCode, null, "SDK exited during startup")
      assert.ok(Date.now() < deadline, "SDK startup deadline")
      await setTimeout(50)
    }
    const tenant = spawnSync(
      "/tmp/tenant-bun",
      [
        "-e",
        `
      const assert = (await import("node:assert/strict")).default;
      const {readFile} = await import("node:fs/promises");
      assert.equal(process.getuid(), 10001);
      assert.equal(process.env.MONGOLGPT_SDK_CONTROL_TOKEN, undefined);
      await assert.rejects(readFile("/proc/${sdk.pid}/environ"), {code:"EACCES"});
      let checks = 0;
      for (const path of ["/api/execute", "/api/read-file", "/api/process/kill"]) {
        for (const headers of [{}, {"${sdkControlHeader}":"0".repeat(64)}, {authorization:"Bearer fake"}]) {
          const response = await fetch("http://127.0.0.1:3000" + path, {
            method:"POST", headers:{"content-type":"application/json", ...headers},
            body:JSON.stringify({command:"id -u; touch /tmp/tenant-root-exec",sessionId:"__DISABLE_SESSION__",cwd:"${directory}",path:"/proc/${sdk.pid}/environ"})
          });
          assert.equal(response.status, 403);
          assert.deepEqual(await response.json(), {error:"forbidden"});
          checks++;
        }
      }
      for (const path of ["/rpc", "/ws", "/api/ws", "/ws/pty?sessionId=test"]) {
        for (const headers of [{}, {"${sdkControlHeader}":"f".repeat(64)}]) {
          const response = await fetch("http://127.0.0.1:3000" + path, {
            headers:{upgrade:"websocket",connection:"Upgrade","sec-websocket-version":"13","sec-websocket-key":Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),...headers}
          });
          assert.equal(response.status, 403);
          assert.deepEqual(await response.json(), {error:"forbidden"});
          checks++;
        }
      }
      assert.equal(await Bun.file("/tmp/tenant-root-exec").exists(), false);
      console.log(JSON.stringify({callerUID:process.getuid(),deniedRequests:checks,rootEnvironmentDenied:true}));
    `,
      ],
      {
        cwd: "/tmp",
        uid: 10001,
        gid: 10001,
        env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    )
    assert.equal(tenant.status, 0, tenant.stderr)
    console.log(tenant.stdout.trim())
    const response = await fetch("http://127.0.0.1:3000/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json", [sdkControlHeader]: token },
      body: JSON.stringify({ command: "id -u", sessionId: "__DISABLE_SESSION__", cwd: directory }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200)
    const result = (await response.json()) as { success: boolean; stdout: string }
    assert.equal(result.success, true)
    assert.equal(result.stdout.trim(), "0")
    // Workers' DOM types omit Bun's supported WebSocket header option.
    const BunSocket = WebSocket as unknown as {
      new (url: string, options: { headers: Record<string, string> }): WebSocket
    }
    const socket = new BunSocket("ws://127.0.0.1:3000/rpc", { headers: { [sdkControlHeader]: token } })
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        socket.close()
        reject(new Error("Authenticated RPC upgrade timeout"))
      }, 10_000)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error("Authenticated RPC upgrade failed"))
      }
    })
    // Exercise the same installed RPC library as the SDK, not a test protocol imitation.
    const require = createRequire(createRequire(import.meta.url).resolve("@cloudflare/sandbox"))
    const { newWebSocketRpcSession } = require("capnweb") as {
      newWebSocketRpcSession(socket: WebSocket): Disposable & {
        utils: {
          createSession(options: { id: string; cwd: string }): Promise<{ success: boolean }>
          deleteSession(id: string): Promise<{ success: boolean }>
        }
        processes: {
          listProcesses(): Promise<{ success: boolean; processes: { id: string }[] }>
          getProcess(id: string): Promise<{ success: boolean; process: { id: string; status: string } }>
          startProcess(command: string, session: string, options: { processId: string }): Promise<{ success: boolean }>
          killProcess(id: string): Promise<{ success: boolean }>
        }
      }
    }
    const rpc = newWebSocketRpcSession(socket)
    const rpcDeadline = AbortSignal.timeout(10_000)
    try {
      await Promise.race([
        (async () => {
          const listed = await rpc.processes.listProcesses()
          assert.equal(listed.success, true)
          assert.ok(Array.isArray(listed.processes))
          await assert.rejects(async () => await rpc.processes.getProcess("mongolgpt-server"), {
            message: "Process mongolgpt-server not found",
          })
          assert.equal((await rpc.utils.createSession({ id: "control-probe", cwd: directory })).success, true)
          const started = await rpc.processes.startProcess("sleep 30", "control-probe", {
            processId: "mongolgpt-control-probe",
          })
          assert.equal(started.success, true)
          const found = await rpc.processes.getProcess("mongolgpt-control-probe")
          assert.equal(found.success, true)
          assert.equal(found.process.id, "mongolgpt-control-probe")
          assert.equal(found.process.status, "running")
          assert.equal((await rpc.processes.killProcess("mongolgpt-control-probe")).success, true)
          assert.equal((await rpc.utils.deleteSession("control-probe")).success, true)
        })(),
        new Promise<never>((_, reject) => {
          rpcDeadline.addEventListener("abort", () => reject(new Error("Authenticated SDK RPC roundtrip timeout")), {
            once: true,
          })
        }),
      ])
    } finally {
      rpc[Symbol.dispose]()
      socket.close()
    }
    console.log("Authenticated SDK command and RPC list/missing/start/get/kill roundtrips passed")
    try {
      await testWorkerControl(node!, runtimeSecret, token)
    } catch (error) {
      const diagnostics = (await readFile("/tmp/sdk.log", "utf8")) + (await readFile("/tmp/sdk-error.log", "utf8"))
      console.error(
        "Isolated SDK diagnostics:",
        diagnostics.replaceAll(token, "[REDACTED]").replaceAll(runtimeSecret, "[REDACTED]").slice(-3000),
      )
      throw error
    }
    assert.equal((await readFile("/tmp/sdk.log", "utf8")).includes(token), false)
    assert.equal((await readFile("/tmp/sdk-error.log", "utf8")).includes(token), false)
  } finally {
    sdk.kill("SIGTERM")
    const timer = globalThis.setTimeout(() => {
      if (sdk.exitCode === null) sdk.kill("SIGKILL")
    }, 10_000)
    try {
      await sdk.exited
    } finally {
      clearTimeout(timer)
    }
  }
}

async function hash(path: string) {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
}

async function testWorkerControl(node: string, runtimeSecret: string, token: string) {
  const transientRoot = join(root, ".tmp")
  await mkdir(transientRoot, { recursive: true })
  const directory = await mkdtemp(join(transientRoot, "sandbox-control-worker-"))
  try {
    const build = await Bun.build({
      entrypoints: [join(root, "test/sandbox-control-worker.integration.ts")],
      outdir: directory,
      naming: "probe.mjs",
      target: "node",
      packages: "external",
    })
    if (!build.success) throw new AggregateError(build.logs, "Workers control probe build failed")
    const child = Bun.spawn(
      [node, join(directory, "probe.mjs"), join(root, "test/fixtures/sandbox-control-worker.ts")],
      {
        cwd: root,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp/sdk-home",
          TMPDIR: "/tmp",
          WRANGLER_SEND_METRICS: "false",
          MONGOLGPT_RUNTIME_SECRET: runtimeSecret,
          EXPECTED_SDK_TOKEN: token,
          ...toolEnv,
        },
        stdout: Bun.file("/tmp/worker-control.log"),
        stderr: Bun.file("/tmp/worker-control-error.log"),
      },
    )
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 90_000)
    try {
      const code = await child.exited
      const stdout = await readFile("/tmp/worker-control.log", "utf8")
      const stderr = await readFile("/tmp/worker-control-error.log", "utf8")
      assert.equal(stdout.includes(token) || stderr.includes(token), false, "Worker logs exposed the control token")
      assert.equal(
        stdout.includes(runtimeSecret) || stderr.includes(runtimeSecret),
        false,
        "Worker logs exposed the runtime secret",
      )
      assert.equal(code, 0, `Workers control probe failed: ${stderr.slice(-3000)}\n${stdout.slice(-3000)}`)
      console.log(stdout.trim())
    } finally {
      clearTimeout(timer)
    }
  } finally {
    const inside = relative(transientRoot, directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Worker probe cleanup escaped test root")
    await rm(directory, { recursive: true, force: true })
  }
}
