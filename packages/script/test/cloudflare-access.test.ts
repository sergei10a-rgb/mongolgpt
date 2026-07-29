import { describe, expect, test } from "bun:test"
import {
  CloudflareAccessPreflightError,
  configureCloudflareAccessMfa,
  mergeIndependentMfa,
  preflightCloudflareAccess,
} from "../src/cloudflare-access"

describe("Cloudflare Access deployment preflight", () => {
  test("verifies the organization and read access to Access applications", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const responses = [
      response({
        success: true,
        result: { auth_domain: "mongolgpt.cloudflareaccess.com" },
      }),
      response({ success: true, result: [{ type: "onetimepin" }] }),
      response({ success: true, result: [] }),
    ]
    const result = await preflightCloudflareAccess({
      accountId: "account/id",
      token: "access-token",
      fetcher: async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init?.headers).get("authorization"),
        })
        const next = responses.shift()
        if (!next) throw new Error("unexpected request")
        return next
      },
    })

    expect(result).toEqual({ teamDomain: "https://mongolgpt.cloudflareaccess.com" })
    expect(requests).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/account%2Fid/access/organizations",
        authorization: "Bearer access-token",
      },
      {
        url: "https://api.cloudflare.com/client/v4/accounts/account%2Fid/access/identity_providers?per_page=1",
        authorization: "Bearer access-token",
      },
      {
        url: "https://api.cloudflare.com/client/v4/accounts/account%2Fid/access/apps?per_page=1",
        authorization: "Bearer access-token",
      },
    ])
  })

  test("fails closed when the token cannot read Access applications", async () => {
    const responses = [
      response({
        success: true,
        result: { auth_domain: "mongolgpt.cloudflareaccess.com" },
      }),
      response({ success: true, result: [{ type: "onetimepin" }] }),
      response(
        {
          success: false,
          errors: [{ message: "permission denied" }],
        },
        403,
      ),
    ]

    const error = await rejection(
      preflightCloudflareAccess({
        accountId: "account-id",
        token: "must-not-leak",
        fetcher: async () => responses.shift()!,
      }),
    )
    expect(error).toBeInstanceOf(CloudflareAccessPreflightError)
    expect(String(error)).toContain("Access application жагсаалтыг унших")
    expect(String(error)).not.toContain("must-not-leak")
  })

  test("rejects an uninitialized organization and oversized responses", async () => {
    expect(
      String(
        await rejection(
          preflightCloudflareAccess({
            accountId: "account-id",
            token: "access-token",
            fetcher: async () => response({ success: true, result: {} }),
          }),
        ),
      ),
    ).toContain("organization эхлүүлээгүй")

    expect(
      String(
        await rejection(
          preflightCloudflareAccess({
            accountId: "account-id",
            token: "access-token",
            fetcher: async () =>
              new Response("{}", {
                headers: { "content-length": String(33 * 1024) },
              }),
          }),
        ),
      ),
    ).toContain("хэт том хариу")
  })

  test("requires at least one configured login method", async () => {
    const responses = [
      response({
        success: true,
        result: { auth_domain: "mongolgpt.cloudflareaccess.com" },
      }),
      response({ success: true, result: [] }),
    ]

    expect(
      String(
        await rejection(
          preflightCloudflareAccess({
            accountId: "account-id",
            token: "access-token",
            fetcher: async () => responses.shift()!,
          }),
        ),
      ),
    ).toContain("login method")
  })
})

describe("Cloudflare Access organization MFA", () => {
  test("preserves unrelated organization settings and existing authenticators", () => {
    const result = mergeIndependentMfa({
      auth_domain: "mongolgpt.cloudflareaccess.com",
      auto_redirect_to_identity: true,
      login_design: { header_text: "MongolGPT" },
      mfa_config: {
        allowed_authenticators: ["piv_key", "totp"],
        required_aaguids: "05ddacda-5131-41ab-9eeb-6763f8dce3be",
        session_duration: "8h",
      },
      mfa_required_for_all_apps: true,
    })

    expect(result).toEqual({
      auth_domain: "mongolgpt.cloudflareaccess.com",
      auto_redirect_to_identity: true,
      login_design: { header_text: "MongolGPT" },
      mfa_config: {
        allowed_authenticators: ["piv_key", "totp", "biometrics", "security_key"],
        required_aaguids: "05ddacda-5131-41ab-9eeb-6763f8dce3be",
        session_duration: "8h",
      },
      mfa_required_for_all_apps: true,
    })
  })

  test("writes and verifies organization-level Independent MFA without leaking the token", async () => {
    const requests: Array<{ method: string; body?: unknown; authorization: string | null }> = []
    const existing = {
      auth_domain: "mongolgpt.cloudflareaccess.com",
      name: "MongolGPT",
      auto_redirect_to_identity: false,
      mfa_config: { allowed_authenticators: ["totp"] },
    }
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      requests.push({
        method: init?.method ?? "GET",
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      if ((init?.method ?? "GET") === "GET") return response({ success: true, result: existing })
      return response({ success: true, result: body })
    }

    const result = await configureCloudflareAccessMfa({
      accountId: "account-id",
      token: "must-not-leak",
      fetcher,
    })

    expect(result).toEqual({
      teamDomain: "https://mongolgpt.cloudflareaccess.com",
      authenticators: ["totp", "biometrics", "security_key"],
    })
    expect(requests).toEqual([
      {
        method: "GET",
        authorization: "Bearer must-not-leak",
      },
      {
        method: "PUT",
        authorization: "Bearer must-not-leak",
        body: {
          ...existing,
          mfa_config: {
            allowed_authenticators: ["totp", "biometrics", "security_key"],
            session_duration: "24h",
          },
          mfa_required_for_all_apps: false,
        },
      },
    ])
  })

  test("fails closed when Cloudflare does not confirm the MFA policy", async () => {
    const responses = [
      response({
        success: true,
        result: {
          auth_domain: "mongolgpt.cloudflareaccess.com",
          mfa_config: { allowed_authenticators: [] },
        },
      }),
      response({
        success: true,
        result: {
          auth_domain: "mongolgpt.cloudflareaccess.com",
          mfa_config: { allowed_authenticators: [], session_duration: "24h" },
        },
      }),
    ]

    expect(
      String(
        await rejection(
          configureCloudflareAccessMfa({
            accountId: "account-id",
            token: "must-not-leak",
            fetcher: async () => responses.shift()!,
          }),
        ),
      ),
    ).toContain("Independent MFA тохиргоог баталгаажуулсангүй")
  })
})

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Promise амжилтгүй болох ёстой байсан.")
}
