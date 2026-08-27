import {
  inspectAppHtml,
  inspectHostedAppRelease,
  inspectHostedAppRuntime,
  type AppRuntimeContract,
} from "@mongolgpt/script/deployment-smoke-contract"

export function verifyHostedWebArtifact(input: {
  html: string
  appUrl: string
  runtimeUrl: string
  channel: AppRuntimeContract["channel"]
  releaseSha: string
}) {
  const contract = inspectAppHtml(input.html, input.appUrl)
  const runtimeHealthUrl = new URL("/global/health", `${input.runtimeUrl.replace(/\/+$/, "")}/`).toString()
  inspectHostedAppRuntime(contract, { channel: input.channel, runtimeHealthUrl })
  inspectHostedAppRelease(input.html, input.releaseSha)
  return contract
}

if (import.meta.main) {
  const artifactPath = process.argv[2] ?? "packages/app/dist/index.html"
  const file = Bun.file(artifactPath)
  if (!(await file.exists())) throw new Error(`MongolGPT веб artifact олдсонгүй: ${artifactPath}`)

  const appUrl = requiredEnvironment("VITE_MONGOLGPT_APP_URL")
  const runtimeUrl = requiredEnvironment("VITE_MONGOLGPT_SERVER_URL")
  const releaseSha = requiredEnvironment("VITE_MONGOLGPT_RELEASE_SHA")
  const channel = hostedChannel(requiredEnvironment("MONGOLGPT_CHANNEL"))
  const contract = verifyHostedWebArtifact({ html: await file.text(), appUrl, runtimeUrl, channel, releaseSha })
  console.log(`MongolGPT hosted веб artifact баталгаажлаа: ${contract.channel} ${contract.serverUrl} ${releaseSha}`)
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} дутуу байна`)
  return value
}

function hostedChannel(value: string): AppRuntimeContract["channel"] {
  if (value === "dev" || value === "beta" || value === "prod") return value
  if (value === "latest") return "prod"
  throw new Error(`MONGOLGPT_CHANNEL буруу байна: ${value}`)
}
