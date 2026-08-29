import type { KVNamespace } from "@cloudflare/workers-types"
import { z } from "zod"
import { issuer } from "@openauthjs/openauth"
import type { Theme } from "@openauthjs/openauth/ui/theme"
import { createSubjects } from "@openauthjs/openauth/subject"
import { THEME_OPENAUTH } from "@openauthjs/openauth/ui/theme"
import { GithubProvider } from "@openauthjs/openauth/provider/github"
import { GoogleOidcProvider } from "@openauthjs/openauth/provider/google"
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare"
import { AccountAccess } from "@mongolgpt/console-core/account-access.js"
import { provisionOAuthAccountIdentity } from "@mongolgpt/console-core/oauth-account-provisioning.js"
import { Workspace } from "@mongolgpt/console-core/workspace.js"
import { Actor } from "@mongolgpt/console-core/actor.js"
import { Resource } from "@mongolgpt/console-resource"
import { User } from "@mongolgpt/console-core/user.js"
import { and, Database, eq, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import {
  readTurnstileAuthorizationSubmission,
  turnstileAuthorizationRequest,
  turnstileRetryUrl,
  verifyTurnstile,
} from "@mongolgpt/console-core/turnstile.js"
import { isAllowedNonProductionEmail } from "./auth-allowlist"
import { inspectOAuthProviderConfiguration } from "@mongolgpt/console-core/oauth-provider-config.js"
import { authStateError } from "./auth-error"

type Env = {
  AuthStorage: KVNamespace
  MONGOLGPT_AUTH_EMAIL_DOMAINS?: string
  MONGOLGPT_CONSOLE_ORIGIN?: string
  MONGOLGPT_TURNSTILE_ENABLED?: string
}

const OAuthSuccessResponseSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("github"), tokenset: z.object({ access: z.string().min(1) }) }),
  z.object({
    provider: z.literal("google"),
    id: z.object({ email_verified: z.boolean(), sub: z.string().min(1), email: z.string().email() }),
  }),
])
const GitHubEmailsSchema = z.array(z.object({ email: z.string().email(), primary: z.boolean(), verified: z.boolean() }))
const GitHubUserSchema = z.object({ id: z.union([z.string().min(1), z.number().int().nonnegative()]) })

export const subjects = createSubjects({
  account: z.object({
    accountID: z.string(),
    email: z.string(),
    newAccount: z.boolean().optional(),
    authVersion: z.number().int().nonnegative().optional(),
  }),
  user: z.object({
    userID: z.string(),
    workspaceID: z.string(),
  }),
})

const MY_THEME: Theme = {
  ...THEME_OPENAUTH,
  logo: "/favicon-v3.svg",
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const requestUrl = new URL(request.url)
    const oauth = inspectOAuthProviderConfiguration({
      stage: Resource.App.stage,
      githubClientID: Resource.GITHUB_CLIENT_ID_CONSOLE.value,
      githubClientSecret: Resource.GITHUB_CLIENT_SECRET_CONSOLE.value,
      googleClientID: Resource.GOOGLE_CLIENT_ID.value,
    })
    if (requestUrl.pathname === "/health") {
      return Response.json(
        { status: oauth.issues.length === 0 ? "ok" : "unavailable", service: "auth" },
        {
          status: oauth.issues.length === 0 ? 200 : 503,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      )
    }

    if (oauth.issues.length > 0) {
      return Response.json(
        { error: "oauth_unavailable", message: "Нэвтрэх үйлчилгээ түр ашиглах боломжгүй байна." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      )
    }

    if (requestUrl.pathname === "/authorize" && env.MONGOLGPT_TURNSTILE_ENABLED === "true") {
      if (request.method !== "POST") return turnstileRequired()
      const submission = await readTurnstileAuthorizationSubmission(request)
      if (!submission || !env.MONGOLGPT_CONSOLE_ORIGIN) return turnstileRequired()

      let authorizationUrl: URL
      try {
        authorizationUrl = turnstileAuthorizationRequest({
          authUrl: requestUrl.toString(),
          consoleOrigin: env.MONGOLGPT_CONSOLE_ORIGIN,
          submission,
        })
      } catch {
        return turnstileRequired()
      }

      const verification = await verifyTurnstile({
        token: submission.token,
        secret: Resource.TurnstileSecretKey.value,
        expectedHostname: new URL(env.MONGOLGPT_CONSOLE_ORIGIN).hostname,
        remoteIp: request.headers.get("cf-connecting-ip") ?? undefined,
      })
      if (!verification.ok) {
        const retry = turnstileRetryUrl({
          consoleOrigin: env.MONGOLGPT_CONSOLE_ORIGIN,
          submission,
          reason: verification.reason,
        })
        return new Response(null, {
          status: 303,
          headers: { location: retry.toString(), "cache-control": "no-store" },
        })
      }

      const headers = new Headers(request.headers)
      for (const name of ["content-length", "content-type", "origin", "referer"]) headers.delete(name)
      request = new Request(authorizationUrl, { method: "GET", headers })
    }

    const result = await issuer({
      theme: MY_THEME,
      providers: {
        ...(oauth.github
          ? {
              github: GithubProvider({
                clientID: Resource.GITHUB_CLIENT_ID_CONSOLE.value,
                clientSecret: Resource.GITHUB_CLIENT_SECRET_CONSOLE.value,
                scopes: ["read:user", "user:email"],
              }),
            }
          : {}),
        ...(oauth.google
          ? {
              google: GoogleOidcProvider({
                clientID: Resource.GOOGLE_CLIENT_ID.value,
                scopes: ["openid", "email"],
              }),
            }
          : {}),
        //        email: CodeProvider({
        //          async request(req, state, form, error) {
        //            console.log(state)
        //            const params = new URLSearchParams()
        //            if (error) {
        //              params.set("error", error.type)
        //            }
        //            if (state.type === "start") {
        //              return Response.redirect(process.env.AUTH_FRONTEND_URL + "/auth/email?" + params.toString(), 302)
        //            }
        //
        //            if (state.type === "code") {
        //              return Response.redirect(process.env.AUTH_FRONTEND_URL + "/auth/code?" + params.toString(), 302)
        //            }
        //
        //            return new Response("ok")
        //          },
        //          async sendCode(claims, code) {
        //            const email = z.string().email().parse(claims.email)
        //            const cmd = new SendEmailCommand({
        //              Destination: {
        //                ToAddresses: [email],
        //              },
        //              FromEmailAddress: `SST <auth@${Resource.Email.sender}>`,
        //              Content: {
        //                Simple: {
        //                  Body: {
        //                    Html: {
        //                      Data: `Your pin code is <strong>${code}</strong>`,
        //                    },
        //                    Text: {
        //                      Data: `Your pin code is ${code}`,
        //                    },
        //                  },
        //                  Subject: {
        //                    Data: "SST Console Pin Code: " + code,
        //                  },
        //                },
        //              },
        //            })
        //            await ses.send(cmd)
        //          },
        //        }),
      },
      storage: CloudflareStorage({
        // @ts-ignore
        namespace: env.AuthStorage,
      }),
      subjects,
      error: async () => authStateError(env.MONGOLGPT_CONSOLE_ORIGIN),
      async success(ctx, response) {
        const oauthResponse = OAuthSuccessResponseSchema.parse(response)
        let subject: string | undefined
        let email: string | undefined

        if (oauthResponse.provider === "github") {
          const headers = {
            Authorization: `Bearer ${oauthResponse.tokenset.access}`,
            "User-Agent": "mongolgpt",
            Accept: "application/vnd.github+json",
          }
          const emails = GitHubEmailsSchema.parse(
            await fetch("https://api.github.com/user/emails", { headers }).then((response) => response.json()),
          )
          const user = GitHubUserSchema.parse(
            await fetch("https://api.github.com/user", { headers }).then((response) => response.json()),
          )
          subject = user.id.toString()

          const primaryEmail = emails.find((entry) => entry.primary)
          if (!primaryEmail) throw new Error("GitHub хэрэглэгчийн үндсэн имэйл олдсонгүй")
          if (!primaryEmail.verified) throw new Error("GitHub хэрэглэгчийн үндсэн имэйл баталгаажаагүй байна")
          email = primaryEmail.email
        } else if (oauthResponse.provider === "google") {
          if (!oauthResponse.id.email_verified) throw new Error("Google имэйл баталгаажаагүй байна")
          subject = oauthResponse.id.sub
          email = oauthResponse.id.email
        } else throw new Error("Нэвтрэх үйлчилгээ үзүүлэгчийг дэмжихгүй байна")

        if (!email) throw new Error("Имэйл олдсонгүй")
        if (!subject) throw new Error("Хэрэглэгчийн таних дугаар олдсонгүй")

        if (
          Resource.App.stage !== "production" &&
          !isAllowedNonProductionEmail(email, env.MONGOLGPT_AUTH_EMAIL_DOMAINS)
        ) {
          throw new Error("Энэ имэйл хөгжүүлэлтийн орчинд зөвшөөрөгдөөгүй байна")
        }

        // Get account
        const provisioning = await provisionOAuthAccountIdentity({
          provider: oauthResponse.provider,
          subject,
          email,
        })
        const accountID = provisioning.accountID
        const newAccount = provisioning.newAccount
        const access = await AccountAccess.verify({ accountID })
        if (!access.allowed) {
          if (access.reason === "suspended") {
            throw new Error("Таны MongolGPT аккаунт түр түдгэлзсэн байна.")
          }
          throw new Error("MongolGPT аккаунтын нэвтрэх эрх хүчингүй болсон байна.")
        }

        // Get workspace
        await Actor.provide("account", { accountID, email }, async () => {
          await User.joinInvitedWorkspaces()
          const workspaces = await Database.use((tx) =>
            tx
              .select({ id: WorkspaceTable.id })
              .from(WorkspaceTable)
              .innerJoin(UserTable, eq(UserTable.workspaceID, WorkspaceTable.id))
              .where(
                and(
                  eq(UserTable.accountID, accountID),
                  isNull(UserTable.timeDeleted),
                  isNull(WorkspaceTable.timeDeleted),
                ),
              ),
          )
          if (workspaces.length === 0) {
            await Workspace.create({ name: "Миний орчин" })
          }
        })
        return ctx.subject("account", accountID, {
          accountID,
          email,
          newAccount,
          authVersion: access.authVersion,
        })
      },
    }).fetch(request, env, ctx)
    return result
  },
}

function turnstileRequired() {
  return Response.json(
    {
      error: "turnstile_required",
      message: "Нэвтрэхийн өмнө Cloudflare Turnstile баталгаажуулалт шаардлагатай.",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  )
}
