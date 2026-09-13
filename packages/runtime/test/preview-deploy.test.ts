import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import candidate from "../wrangler.candidate.dev.json"
import {
  ensurePreviewAccessApplication,
  inspectPreviewIngress,
  previewAccessApplicationPayload,
  previewDeployCommand,
  previewDeployContext,
  previewWranglerConfig,
  verifyPreviewIngress,
  verifyPreviewAccessPolicy,
  verifyPreviewWorker,
} from "../script/deploy-dev-preview"

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "sergei10a-rgb/mongolgpt",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  RUNNER_OS: "Linux",
  RUNNER_TEMP: resolve(tmpdir()),
  MONGOLGPT_OWNER_DEV_PREVIEW_CONFIRMATION: "DEPLOY OWNER DEV PREVIEW",
  CLOUDFLARE_ACCOUNT_ID: candidate.account_id,
  CLOUDFLARE_API_TOKEN: "deploy-token-not-real",
  CLOUDFLARE_ACCESS_API_TOKEN: "access-token-not-real",
}

test("owner preview deployment is restricted to explicit owner main Linux dev context", () => {
  expect(previewDeployContext(env)).toEqual({
    accountID: candidate.account_id,
    worker: "mongolgpt-preview-dev",
    sourceCommit: env.GITHUB_SHA,
    run: "123:2",
    output: join(env.RUNNER_TEMP, "runtime-dev-preview-receipt.json"),
  })
  for (const key of Object.keys(env)) expect(() => previewDeployContext({ ...env, [key]: "" })).toThrow()
  for (const change of [
    { GITHUB_REPOSITORY: "opencode/opencode" },
    { GITHUB_REF: "refs/heads/dev" },
    { RUNNER_OS: "Windows" },
    { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) },
    { MONGOLGPT_OWNER_DEV_PREVIEW_CONFIRMATION: "DEPLOY DEV PREVIEW" },
    { RUNNER_TEMP: "relative" },
    { GITHUB_SHA: "not-a-commit" },
  ])
    expect(() => previewDeployContext({ ...env, ...change })).toThrow()
})

test("wrangler config deploys one Access-protected custom domain to the private candidate", () => {
  const config = previewWranglerConfig({
    accessAudience: "a".repeat(64),
    accessTeamDomain: "raspy-frog-02f6.cloudflareaccess.com",
  })
  expect(config).toEqual({
    name: "mongolgpt-preview-dev",
    account_id: candidate.account_id,
    main: fileURLToPath(new URL("../../console/admin/src/preview/worker.ts", import.meta.url)),
    compatibility_date: candidate.compatibility_date,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "preview.dev.mgpt.mn", custom_domain: true }],
    assets: {
      directory: fileURLToPath(new URL("../../app/dist", import.meta.url)),
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    },
    services: [{ binding: "CANDIDATE", service: "mongolgpt-runtime-candidate-dev", remote: true }],
    vars: {
      STAGE: "dev",
      ACCESS_AUDIENCE: "a".repeat(64),
      ACCESS_TEAM_DOMAIN: "https://raspy-frog-02f6.cloudflareaccess.com",
    },
  })
  expect(config.routes).toHaveLength(1)
  expect(config).not.toHaveProperty("custom_domain")
  expect(() =>
    previewWranglerConfig({ accessAudience: "", accessTeamDomain: "https://mongolgpt.cloudflareaccess.com" }),
  ).toThrow()
  expect(() =>
    previewWranglerConfig({ accessAudience: "aud", accessTeamDomain: "https://cloudflareaccess.com" }),
  ).toThrow()
})

test("deploy command uses the pinned runtime wrangler and cannot add domain flags", () => {
  const node = resolve("node")
  const configPath = join(env.RUNNER_TEMP, "preview", "wrangler.json")
  const command = previewDeployCommand(configPath, node)
  expect(command).toEqual([
    node,
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "deploy",
    `--config=${configPath}`,
  ])
  expect(command).not.toContain("--domain")
  expect(command).not.toContain("--route")
  expect(() => previewDeployCommand("relative", node)).toThrow()
  expect(() => previewDeployCommand(configPath, "node")).toThrow()
})

test("new Access application payload is exact owner-only browser MFA policy", () => {
  expect(previewAccessApplicationPayload()).toEqual({
    name: "MongolGPT owner dev preview",
    domain: "preview.dev.mgpt.mn",
    type: "self_hosted",
    session_duration: "4h",
    allow_authenticate_via_warp: false,
    allow_iframe: false,
    app_launcher_visible: false,
    enable_binding_cookie: true,
    http_only_cookie_attribute: true,
    options_preflight_bypass: false,
    same_site_cookie_attribute: "lax",
    mfa_config: browserMfa(),
    policies: [
      {
        name: "MongolGPT owner dev preview",
        decision: "allow",
        precedence: 1,
        include: [{ email: { email: "sergei10a@gmail.com" } }],
        exclude: [],
        require: [],
        mfa_config: browserMfa(),
      },
    ],
  })
})

test("exact existing Access application is reused without updating it", async () => {
  const requests: Array<{ url: string; method: string | undefined; body?: unknown }> = []
  const responses = [
    response({ success: true, result: organization() }),
    response({ success: true, result: [accessApplication()] }),
    response({ success: true, result: [accessPolicy()] }),
  ]
  const result = await ensurePreviewAccessApplication("access-token", async (url, init) => {
    requests.push({
      url,
      method: init.method,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return responses.shift()!
  })
  expect(result).toEqual({
    id: "11111111-2222-4333-8444-555555555555",
    aud: "a".repeat(64),
    teamDomain: "https://raspy-frog-02f6.cloudflareaccess.com",
  })
  expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "GET", "GET"])
  expect(requests.map((request) => request.url)).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${candidate.account_id}/access/organizations`,
    `https://api.cloudflare.com/client/v4/accounts/${candidate.account_id}/access/apps?domain=preview.dev.mgpt.mn&per_page=10`,
    `https://api.cloudflare.com/client/v4/accounts/${candidate.account_id}/access/apps/11111111-2222-4333-8444-555555555555/policies?per_page=10`,
  ])
})

test("missing Access application is created before its policy is verified", async () => {
  const requests: Array<{ method: string | undefined; body?: unknown }> = []
  const responses = [
    response({ success: true, result: organization() }),
    response({ success: true, result: [] }),
    response({ success: true, result: accessApplication() }),
    response({ success: true, result: [accessPolicy()] }),
  ]
  await ensurePreviewAccessApplication("access-token", async (_url, init) => {
    requests.push({
      method: init.method,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return responses.shift()!
  })
  expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "GET", "POST", "GET"])
  expect(requests[2].body).toEqual(previewAccessApplicationPayload())
})

test("read-only verification never creates a missing Access application", async () => {
  const methods: string[] = []
  const responses = [response({ success: true, result: organization() }), response({ success: true, result: [] })]
  await expect(
    ensurePreviewAccessApplication(
      "access-token",
      async (_url, init) => {
        methods.push(init.method ?? "GET")
        return responses.shift()!
      },
      true,
    ),
  ).rejects.toThrow("Preview Access application is missing")
  expect(methods).toEqual(["GET", "GET"])
})

test("preexisting Access app or policy mismatch fails closed without overwriting", async () => {
  const weakApplication = { ...accessApplication(), same_site_cookie_attribute: "strict" }
  const applicationRequests: (string | undefined)[] = []
  const applicationResponses = [
    response({ success: true, result: organization() }),
    response({ success: true, result: [weakApplication] }),
  ]
  await expect(
    ensurePreviewAccessApplication("must-not-leak", async (_url, init) => {
      applicationRequests.push(init.method)
      return applicationResponses.shift()!
    }),
  ).rejects.toThrow("same_site_cookie_attribute")
  expect(applicationRequests).toEqual([undefined, undefined])

  const policyRequests: (string | undefined)[] = []
  const responses = [
    response({ success: true, result: organization() }),
    response({ success: true, result: [accessApplication()] }),
    response({ success: true, result: [{ ...accessPolicy(), include: [{ everyone: {} }] }] }),
  ]
  await expect(
    ensurePreviewAccessApplication("must-not-leak", async (_url, init) => {
      policyRequests.push(init.method)
      return responses.shift()!
    }),
  ).rejects.toThrow("owner policy")
  expect(policyRequests).toEqual([undefined, undefined, undefined])
})

test("domain ownership guard rejects foreign custom domains, DNS records and routes", () => {
  expect(
    verifyPreviewIngress({
      domains: [{ hostname: "preview.dev.mgpt.mn", service: "mongolgpt-preview-dev" }],
      dnsRecords: [{ name: "preview.dev.mgpt.mn", type: "CNAME" }],
      routes: [],
    }),
  ).toEqual({ publicProtectedDomain: "preview.dev.mgpt.mn" })
  expect(
    verifyPreviewIngress({
      domains: [],
      dnsRecords: [],
      routes: [{ pattern: "preview.dev.mgpt.mn/*", script: "mongolgpt-preview-dev" }],
    }),
  ).toEqual({ publicProtectedDomain: "pending" })
  expect(() =>
    verifyPreviewIngress({
      domains: [{ hostname: "preview.dev.mgpt.mn", service: "someone-else" }],
      dnsRecords: [],
      routes: [],
    }),
  ).toThrow("custom domain")
  expect(() =>
    verifyPreviewIngress({
      domains: [],
      dnsRecords: [{ name: "preview.dev.mgpt.mn", type: "CNAME" }],
      routes: [],
    }),
  ).toThrow("DNS")
  expect(() =>
    verifyPreviewIngress({
      domains: [],
      dnsRecords: [],
      routes: [{ pattern: "*.dev.mgpt.mn/*", script: "someone-else" }],
    }),
  ).toThrow("route")
})

test("ingress inspection reads custom domains, DNS and routes before deployment", async () => {
  const urls: string[] = []
  const responses = [
    response({ success: true, result: [] }),
    response({ success: true, result: [{ id: "b".repeat(32), name: "mgpt.mn" }] }),
    response({ success: true, result: [] }),
    response({ success: true, result: [] }),
  ]
  expect(
    await inspectPreviewIngress("deploy-token", async (url, init) => {
      urls.push(url)
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer deploy-token")
      return responses.shift()!
    }),
  ).toEqual({ publicProtectedDomain: "pending" })
  expect(urls).toEqual([
    `https://api.cloudflare.com/client/v4/accounts/${candidate.account_id}/workers/domains?hostname=preview.dev.mgpt.mn&per_page=10`,
    `https://api.cloudflare.com/client/v4/zones?name=mgpt.mn&account.id=${candidate.account_id}&status=active&per_page=5`,
    `https://api.cloudflare.com/client/v4/zones/${"b".repeat(32)}/dns_records?name=preview.dev.mgpt.mn&per_page=10`,
    `https://api.cloudflare.com/client/v4/zones/${"b".repeat(32)}/workers/routes?per_page=100`,
  ])
})

function organization() {
  return {
    auth_domain: "raspy-frog-02f6.cloudflareaccess.com",
  }
}

function accessApplication() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    aud: "a".repeat(64),
    name: "MongolGPT owner dev preview",
    domain: "preview.dev.mgpt.mn",
    type: "self_hosted",
    session_duration: "4h",
    allow_authenticate_via_warp: false,
    app_launcher_visible: false,
    enable_binding_cookie: true,
    http_only_cookie_attribute: true,
    options_preflight_bypass: false,
    same_site_cookie_attribute: "lax",
    mfa_config: browserMfa(),
  }
}

function accessPolicy() {
  return {
    name: "MongolGPT owner dev preview",
    decision: "allow",
    precedence: 1,
    include: [{ email: { email: "sergei10a@gmail.com" } }],
    exclude: [],
    require: [],
    mfa_config: browserMfa(),
  }
}

function browserMfa() {
  return {
    allowed_authenticators: ["totp", "biometrics", "security_key"],
    mfa_disabled: false,
    session_duration: "1h",
  }
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("owner policy cannot include an additional allow-all rule", () => {
  expect(() =>
    verifyPreviewAccessPolicy({
      ...accessPolicy(),
      include: [{ email: { email: "sergei10a@gmail.com" } }, { everyone: {} }],
    }),
  ).toThrow()
  expect(() =>
    verifyPreviewAccessPolicy({
      ...accessPolicy(),
      include: [{ email: { email: "sergei10a@gmail.com" }, everyone: {} }],
    }),
  ).toThrow()
})

test("preview metadata requires private alternate ingress and no other service or storage bindings", () => {
  const bindings = [
    { name: "ASSETS", type: "assets" },
    { name: "CANDIDATE", type: "service", service: "mongolgpt-runtime-candidate-dev" },
    { name: "STAGE", type: "plain_text", text: "dev" },
    { name: "ACCESS_AUDIENCE", type: "plain_text", text: "a".repeat(64) },
    { name: "ACCESS_TEAM_DOMAIN", type: "plain_text", text: "https://raspy-frog-02f6.cloudflareaccess.com" },
  ]
  const subdomain = { enabled: false, previews_enabled: false }
  expect(() => verifyPreviewWorker({ bindings }, subdomain)).not.toThrow()
  expect(() => verifyPreviewWorker({ bindings }, { ...subdomain, enabled: true })).toThrow()
  expect(() => verifyPreviewWorker({ bindings }, { enabled: false })).toThrow()
  expect(() => verifyPreviewWorker({ bindings: [...bindings, { name: "DB", type: "d1" }] }, subdomain)).toThrow()
  expect(() =>
    verifyPreviewWorker(
      {
        bindings: bindings.map((binding) =>
          binding.type === "service" ? { ...binding, service: "mongolgpt-runtime-dev" } : binding,
        ),
      },
      subdomain,
    ),
  ).toThrow()
})
