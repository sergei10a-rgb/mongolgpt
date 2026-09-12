import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { AdminAccessStateError, devAdminAccess, reconcileAdminAccessState } from "../src/admin-access-state"

const providerUrn = "urn:pulumi:dev::mongolgpt-admin::pulumi:providers:cloudflare::AdminAccessProvider"
const encrypted = {
  "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
  ciphertext: "unchanged-secret",
}

function fixture() {
  const values = {
    accountId: devAdminAccess.accountId,
    domain: devAdminAccess.hostname,
    enableBindingCookie: true,
    httpOnlyCookieAttribute: true,
    sameSiteCookieAttribute: "strict",
    policies: encrypted,
    mfaConfig: { allowedAuthenticators: ["totp", "biometrics", "security_key"], sessionDuration: "1h" },
  }
  const resource: Record<string, unknown> = {
    urn: devAdminAccess.urn,
    type: "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication",
    id: devAdminAccess.applicationId,
    custom: true,
    protect: true,
    provider: `${providerUrn}::provider-id`,
    parent: "urn:pulumi:dev::mongolgpt-admin::pulumi:pulumi:Stack::mongolgpt-admin-dev",
    inputs: structuredClone(values),
    outputs: { ...structuredClone(values), id: devAdminAccess.applicationId, aud: "unchanged-audience" },
  }
  return {
    version: 3,
    checkpoint: {
      stack: "organization/mongolgpt-admin/dev",
      latest: {
        manifest: { time: "2026-09-12T14:00:00Z" },
        secrets_providers: { type: "passphrase", state: { salt: "unchanged-salt" } },
        resources: [
          { urn: providerUrn, type: "pulumi:providers:cloudflare", id: "provider-id", inputs: { apiToken: encrypted } },
          resource,
        ] as Record<string, unknown>[],
        pending_operations: [] as unknown[],
        metadata: {} as Record<string, unknown>,
      },
    },
  }
}

function values(state: ReturnType<typeof fixture>, side: "inputs" | "outputs") {
  return state.checkpoint.latest.resources[1][side] as Record<string, unknown>
}

describe("bounded dev admin cookie state reconciliation", () => {
  test("changes only both cookie attributes and leaves input and opaque secrets untouched", () => {
    const original = fixture()
    const before = JSON.stringify(original)
    const expected = fixture()
    values(expected, "inputs").sameSiteCookieAttribute = "lax"
    values(expected, "outputs").sameSiteCookieAttribute = "lax"
    const result = reconcileAdminAccessState(original)
    expect(result).toEqual({ changed: true, state: expected })
    expect(JSON.stringify(original)).toBe(before)
    expect(reconcileAdminAccessState(result.state)).toEqual({ changed: false, state: expected })
  })

  test("accepts SST export's unwrapped checkpoint and preserves prototype-named JSON properties", () => {
    const source = JSON.parse(JSON.stringify(fixture()).replace('"policies":', '"__proto__":{"keep":true},"policies":'))
    const result = reconcileAdminAccessState(source)
    const expected = source
    values(expected, "inputs").sameSiteCookieAttribute = "lax"
    values(expected, "outputs").sameSiteCookieAttribute = "lax"
    expect(result.state).toEqual(expected)
    expect(reconcileAdminAccessState(fixture().checkpoint).changed).toBe(true)
  })

  test.each(["inputs", "outputs"] as const)(
    "handles a partially reconciled %s without altering anything else",
    (side) => {
      const source = fixture()
      values(source, side).sameSiteCookieAttribute = "lax"
      expect(reconcileAdminAccessState(source).changed).toBe(true)
    },
  )

  test("fails closed for pending operations, integrity errors, duplicates and other stacks", () => {
    const cases = [
      (s: ReturnType<typeof fixture>) => {
        s.version = 2
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.stack = "production"
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.stack = ""
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.secrets_providers.type = "plaintext"
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.resources[0].inputs = { apiToken: "plaintext-token" }
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.metadata.note = { ...encrypted, plaintext: "must-stay-private" }
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.pending_operations.push({ type: "updating" })
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.metadata.integrity_error = {}
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.resources.push(s.checkpoint.latest.resources[1])
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.resources[1].urn = devAdminAccess.urn.replace(":dev::", ":production::")
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.resources.push({ urn: "urn:pulumi:dev::mongolgpt::other" })
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.resources.shift()
      },
      (s: ReturnType<typeof fixture>) => {
        s.checkpoint.latest.resources.push(s.checkpoint.latest.resources[0])
      },
    ]
    for (const change of cases) {
      const state = fixture()
      change(state)
      const before = JSON.stringify(state)
      expect(() => reconcileAdminAccessState(state)).toThrow(AdminAccessStateError)
      expect(JSON.stringify(state)).toBe(before)
    }
  })

  test.each([
    ["id", "other"],
    ["type", "other"],
    ["custom", false],
    ["delete", true],
    ["pendingReplacement", true],
    ["provider", "unrecorded"],
    ["inputs", encrypted],
    ["outputs", null],
  ])("rejects unexpected target %s", (key, value) => {
    const state = fixture()
    state.checkpoint.latest.resources[1][String(key)] = value
    expect(() => reconcileAdminAccessState(state)).toThrow(AdminAccessStateError)
  })

  test.each(["inputs", "outputs"] as const)("rejects wrong identity and weakened or opaque cookies in %s", (side) => {
    for (const [key, value] of [
      ["accountId", "another-account"],
      ["domain", "admin.mgpt.mn"],
      ["enableBindingCookie", false],
      ["httpOnlyCookieAttribute", false],
      ["sameSiteCookieAttribute", "none"],
      ["sameSiteCookieAttribute", undefined],
      ["sameSiteCookieAttribute", encrypted],
      ["sameSiteCookieAttribute", "[secret]"],
    ] as const) {
      const state = fixture()
      values(state, side)[key] = value
      expect(() => reconcileAdminAccessState(state)).toThrow(AdminAccessStateError)
    }
  })

  test("refuses a different output application ID", () => {
    const state = fixture()
    values(state, "outputs").id = "other"
    expect(() => reconcileAdminAccessState(state)).toThrow(AdminAccessStateError)
  })

  test("actual editor preserves a private backup, is idempotent, and audit never writes", async () => {
    await editorFixture(async (run, file, backup) => {
      const original = await readFile(file, "utf8")
      const audit = await run("--audit")
      expect(audit.code).toBe(0)
      expect(JSON.parse(audit.output)).toEqual({ changed: true, liveProtectionVerified: true })
      expect(await readFile(file, "utf8")).toBe(original)
      expect(await Bun.file(backup).exists()).toBe(false)
      expect((await run("--verify")).code).toBe(1)
      expect((await run("--snapshot")).code).toBe(0)
      expect(await readFile(file, "utf8")).toBe(original)
      expect(await readFile(backup, "utf8")).toBe(original)
      expect((await run("--edit")).code).toBe(0)
      expect(await readFile(backup, "utf8")).toBe(original)
      const repaired = await readFile(file, "utf8")
      expect(reconcileAdminAccessState(JSON.parse(repaired)).changed).toBe(false)
      expect((await run("--edit")).code).toBe(1)
      expect((await run("--snapshot")).code).toBe(1)
      expect(await readFile(file, "utf8")).toBe(repaired)
      expect(await readFile(backup, "utf8")).toBe(original)
      expect((await run("--verify")).code).toBe(0)
    })
  })

  test.each(["confirmation", "live-id", "backup", "missing-backup", "outside-path", "unwrapped", "state-race"])(
    "actual editor fails closed for %s",
    async (failure) => {
      await editorFixture(async (run, file, backup) => {
        if (failure === "unwrapped") {
          await writeFile(file, JSON.stringify(fixture().checkpoint))
        }
        if (failure === "state-race") {
          expect((await run("--snapshot")).code).toBe(0)
          const next = fixture()
          next.checkpoint.latest.manifest.time = "2026-09-12T14:01:00Z"
          await writeFile(file, JSON.stringify(next))
        }
        const original = await readFile(file, "utf8")
        if (failure === "backup") await writeFile(backup, "existing-backup")
        const result = await run("--edit", failure)
        expect(result.code).toBe(1)
        expect(result.output).not.toContain("unchanged-secret")
        expect(result.output).not.toContain("fake-token")
        expect(await readFile(file, "utf8")).toBe(original)
        if (failure === "backup") expect(await readFile(backup, "utf8")).toBe("existing-backup")
        else if (failure !== "state-race") expect(await Bun.file(backup).exists()).toBe(false)
      })
    },
  )

  test("workflow is manual, defaults to audit, and cannot deploy, decrypt, or upload state", async () => {
    const source = await readFile(
      new URL("../../../.github/workflows/reconcile-dev-admin-state.yml", import.meta.url),
      "utf8",
    )
    const workflow = Bun.YAML.parse(source) as {
      on: { workflow_dispatch: { inputs: { operation: { default: string } } } }
      permissions: Record<string, string>
      concurrency: { group: string; "cancel-in-progress": boolean }
      jobs: { reconcile: { if: string; environment: string; steps: { run?: string }[] } }
    }
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(workflow.on.workflow_dispatch.inputs.operation.default).toBe("audit")
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.concurrency).toEqual({ group: "cloudflare-deploy-dev", "cancel-in-progress": false })
    expect(workflow.jobs.reconcile.environment).toBe("dev")
    expect(workflow.jobs.reconcile.if).toBe(
      "github.repository == 'sergei10a-rgb/mongolgpt' && github.ref == 'refs/heads/main'",
    )
    expect(source).toContain('test "$CONFIRMATION" = "CONFIRM DEV ADMIN COOKIE STATE"')
    expect(source).toContain('if [ "$OPERATION" = "reconcile" ] && [ "$needs_reconciliation" = "true" ]; then')
    expect(source.indexOf('state.ts --snapshot" bun sst')).toBeLessThan(source.indexOf('state.ts --edit" bun sst'))
    expect(source).toContain("sst state edit --config sst.admin.config.ts --stage=dev")
    expect(source).toContain('--verify <"$state_file"')
    expect(source).not.toMatch(/sst (deploy|refresh|remove)|--decrypt|upload-artifact|sst\.config\.ts/)
  })
})

async function editorFixture(
  check: (
    run: (mode: string, failure?: string) => Promise<{ code: number; output: string }>,
    file: string,
    backup: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "mongolgpt-cookie-editor-test-"))
  const directory = join(root, ".sst/pulumi/test-update/.pulumi/stacks/mongolgpt-admin")
  const file = join(directory, "dev.json")
  const backup = join(root, "mongolgpt-admin-cookie-state-before.json")
  const preload = join(root, "fake-cloudflare.ts")
  const mfa = {
    allowed_authenticators: ["totp", "biometrics", "security_key"],
    session_duration: "1h",
    mfa_disabled: false,
  }
  const responses = [
    { auth_domain: "test.cloudflareaccess.com", mfa_config: mfa },
    [
      {
        id: devAdminAccess.applicationId,
        name: "MongolGPT админ (dev)",
        domain: devAdminAccess.hostname,
        type: "self_hosted",
        session_duration: "4h",
        allow_authenticate_via_warp: false,
        app_launcher_visible: false,
        enable_binding_cookie: true,
        http_only_cookie_attribute: true,
        options_preflight_bypass: false,
        same_site_cookie_attribute: "lax",
        aud: "test-audience",
        mfa_config: mfa,
      },
    ],
    [
      {
        name: "MongolGPT администраторууд",
        decision: "allow",
        precedence: 1,
        include: [{ email: { email: "owner@example.com" } }],
        exclude: [],
        require: [],
        mfa_config: mfa,
      },
    ],
  ]
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(file, JSON.stringify(fixture()))
    // A child-process preload replaces only fetch, so the real CLI and filesystem code run without live credentials/network.
    await writeFile(
      preload,
      `const responses = ${JSON.stringify(responses)};
      if (process.env.TEST_WRONG_LIVE_ID === "true") responses[1][0].id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      globalThis.fetch = async (input, init) => {
        if ((init?.method ?? "GET") !== "GET" || !String(input).startsWith("https://api.cloudflare.com/client/v4/accounts/")) throw new Error("Unexpected network request");
        if (!responses.length) throw new Error("Unexpected extra request");
        return Response.json({ success: true, result: responses.shift() });
      };`,
    )
    await check(
      async (mode, failure) => {
        const child = Bun.spawn(
          [
            process.execPath,
            "--preload",
            preload,
            fileURLToPath(new URL("../../../script/reconcile-admin-access-state.ts", import.meta.url)),
            mode,
            ...(mode === "--edit" || mode === "--snapshot" ? [failure === "outside-path" ? backup : file] : []),
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              MONGOLGPT_DOMAIN: "mgpt.mn",
              CLOUDFLARE_ACCOUNT_ID: devAdminAccess.accountId,
              MONGOLGPT_RECONCILE_ADMIN_ACCESS_STATE:
                failure === "confirmation" ? "" : "CONFIRM DEV ADMIN COOKIE STATE",
              CLOUDFLARE_ACCESS_API_TOKEN: "fake-token",
              SST_SECRET_MongolGPTAdminBootstrapEmails: "owner@example.com",
              TEST_WRONG_LIVE_ID: String(failure === "live-id"),
              RUNNER_TEMP: root,
            },
            stdin: new Blob([JSON.stringify(JSON.parse(await readFile(file, "utf8")).checkpoint ?? {})]),
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const code = await child.exited
        const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`
        return { code, output }
      },
      file,
      backup,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
