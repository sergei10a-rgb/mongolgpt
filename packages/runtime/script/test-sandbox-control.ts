import assert from "node:assert/strict"
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { setTimeout } from "node:timers/promises"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { sdkControlEnv, sdkControlHeader } from "@mongolgpt/runtime-auth/control"
import upstream from "../vendor/sandbox-control/upstream.json"
import { verifySandboxBuild } from "./build-sandbox"

const root = fileURLToPath(new URL("../", import.meta.url))
const binary = `${root}container/sandbox`
const bun = process.execPath
if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Linux root integration runner required")

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
      'mount --make-rprivate /; mount -t tmpfs -o mode=1777 tmpfs /tmp; mount -t tmpfs -o mode=0755 tmpfs /run; ip link set lo up; exec "$1" "$2" --isolated',
      "sandbox-control-test",
      bun,
      fileURLToPath(import.meta.url),
    ],
    { stdout: "inherit", stderr: "inherit", env: { PATH: "/usr/local/bin:/usr/bin:/bin", BUN_BE_BUN: "1" } },
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
  const token = randomBytes(32).toString("hex")
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
    await new Promise<void>((resolve, reject) => {
      const socket = new BunSocket("ws://127.0.0.1:3000/rpc", { headers: { [sdkControlHeader]: token } })
      const timer = globalThis.setTimeout(() => {
        socket.close()
        reject(new Error("Authenticated RPC upgrade timeout"))
      }, 10_000)
      socket.onopen = () => {
        clearTimeout(timer)
        socket.close()
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error("Authenticated RPC upgrade failed"))
      }
    })
    console.log("Authenticated SDK command and RPC WebSocket upgrade passed")
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
