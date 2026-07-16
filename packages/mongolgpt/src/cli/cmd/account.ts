import { cmd } from "./cmd"
import { Duration, Effect, Match, Option } from "effect"
import { UI } from "../ui"
import { Account } from "@/account/account"
import { AccountID, OrgID, PollError, PollExpired, type PollResult, type AccountError } from "@/account/schema"
import { defaultConsoleUrl } from "@/account/url"
import { effectCmd } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import open from "open"

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const println = (msg: string) => Effect.sync(() => UI.println(msg))

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const activeSuffix = (isActive: boolean) => (isActive ? dim(" (идэвхтэй)") : "")

export { defaultConsoleUrl }

export const formatAccountLabel = (account: { email: string; url: string }, isActive: boolean) =>
  `${account.email} ${dim(account.url)}${activeSuffix(isActive)}`

export const formatPostLoginGuidance = () => [
  "Бүртгэлээр нэвтэрсний дараа MongolGPT Free Auto анхдагчаар идэвхжинэ.",
  "Орон нутгийн болон OpenAI-тэй нийцтэй загваруудыг хүсвэл дараа нь нэмэлтээр холбоно.",
  "NVIDIA NIM-ийг өөрийн API түлхүүрээр хувийн хөгжүүлэлт, туршилт, үнэлгээнд холбоно. Үйлдвэрлэлийн хэрэглээнд зохих NVIDIA лиценз эсвэл захиалга шаардлагатай.",
]

export const accountOnboardingRequired = (hasActiveAccount: boolean) => !hasActiveAccount

const formatOrgChoiceLabel = (account: { email: string }, org: { name: string }, isActive: boolean) =>
  `${org.name} (${account.email})${activeSuffix(isActive)}`

export const formatOrgLine = (
  account: { email: string; url: string },
  org: { id: string; name: string },
  isActive: boolean,
) => {
  const dot = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : " "
  const name = isActive ? UI.Style.TEXT_HIGHLIGHT_BOLD + org.name + UI.Style.TEXT_NORMAL : org.name
  return `  ${dot} ${name}  ${dim(account.email)}  ${dim(account.url)}  ${dim(org.id)}`
}

const isActiveOrgChoice = (
  active: Option.Option<{ id: AccountID; active_org_id: OrgID | null }>,
  choice: { accountID: AccountID; orgID: OrgID },
) => Option.isSome(active) && active.value.id === choice.accountID && active.value.active_org_id === choice.orgID

const loginEffect = Effect.fn("login")(function* (url: string) {
  const service = yield* Account.Service

  yield* Prompt.intro("Нэвтрэх")
  const method = yield* service.browserLogin(url).pipe(
    Effect.map((login) => ({ _tag: "browser" as const, login })),
    Effect.catch(() => service.login(url).pipe(Effect.map((login) => ({ _tag: "device" as const, login })))),
  )

  if (method._tag === "browser") {
    yield* Prompt.log.info("Энд очно уу: " + method.login.url)
    yield* openBrowser(method.login.url)

    const s = Prompt.spinner()
    yield* s.start("MongolGPT аккаунтын зөвшөөрөл хүлээж байна...")

    const result = yield* method.login.wait.pipe(
      Effect.timeout(Duration.minutes(5)),
      Effect.catchTag("TimeoutError", () => Effect.succeed(new PollExpired())),
      Effect.catch((cause) => Effect.succeed(new PollError({ cause }))),
    )

    yield* Match.valueTags(result, {
      PollSuccess: (r) =>
        Effect.gen(function* () {
          yield* s.stop(r.email + " нэрээр нэвтэрлээ")
          for (const message of formatPostLoginGuidance()) {
            yield* Prompt.log.info(message)
          }
          yield* Prompt.outro("Дууслаа")
        }),
      PollExpired: () => s.stop("Нэвтрэх хугацаа дууссан", 1),
      PollError: (r) => s.stop("Алдаа: " + String(r.cause), 1),
    })
    return
  }

  const login = method.login

  yield* Prompt.log.info("Энд очно уу: " + login.url)
  yield* Prompt.log.info("Код оруулна уу: " + login.user)
  yield* openBrowser(login.url)

  const s = Prompt.spinner()
  yield* s.start("Зөвшөөрөл хүлээж байна...")

  const poll = (wait: Duration.Duration): Effect.Effect<PollResult, AccountError> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* service.poll(login)
      if (result._tag === "PollPending") return yield* poll(wait)
      if (result._tag === "PollSlow") return yield* poll(Duration.sum(wait, Duration.seconds(5)))
      return result
    })

  const result = yield* poll(login.interval).pipe(
    Effect.timeout(login.expiry),
    Effect.catchTag("TimeoutError", () => Effect.succeed(new PollExpired())),
  )

  yield* Match.valueTags(result, {
    PollSuccess: (r) =>
      Effect.gen(function* () {
        yield* s.stop(r.email + " нэрээр нэвтэрлээ")
        for (const message of formatPostLoginGuidance()) {
          yield* Prompt.log.info(message)
        }
        yield* Prompt.outro("Дууслаа")
      }),
    PollExpired: () => s.stop("Төхөөрөмжийн кодын хугацаа дууссан", 1),
    PollDenied: () => s.stop("Зөвшөөрөл татгалзагдлаа", 1),
    PollError: (r) => s.stop("Алдаа: " + String(r.cause), 1),
    PollPending: () => s.stop("Санаандгүй төлөв", 1),
    PollSlow: () => s.stop("Санаандгүй төлөв", 1),
  })
})

export const ensureAccountLogin = Effect.fn("Cli.account.ensureLogin")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (!accountOnboardingRequired(Option.isSome(active))) return true

  yield* loginEffect(defaultConsoleUrl)
  return Option.isSome(yield* service.active())
})

const logoutEffect = Effect.fn("logout")(function* (email?: string) {
  const service = yield* Account.Service
  const accounts = yield* service.list()
  if (accounts.length === 0) return yield* println("Нэвтрээгүй байна")

  if (email) {
    const match = accounts.find((a) => a.email === email)
    if (!match) return yield* println("Аккаунт олдсонгүй: " + email)
    yield* service.remove(match.id)
    yield* Prompt.outro(email + " аккаунтаас гарлаа")
    return
  }

  const active = yield* service.active()
  const activeID = Option.map(active, (a) => a.id)

  yield* Prompt.intro("Гарах")

  const opts = accounts.map((a) => {
    const isActive = Option.isSome(activeID) && activeID.value === a.id
    return {
      value: a,
      label: formatAccountLabel(a, isActive),
    }
  })

  const selected = yield* Prompt.select({ message: "Гарах аккаунтаа сонгоно уу", options: opts })
  if (Option.isNone(selected)) return

  yield* service.remove(selected.value.id)
  yield* Prompt.outro(selected.value.email + " аккаунтаас гарлаа")
})

interface OrgChoice {
  orgID: OrgID
  accountID: AccountID
  label: string
}

const switchEffect = Effect.fn("switch")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println("Нэвтрээгүй байна")

  const active = yield* service.active()

  const opts = groups.flatMap((group) =>
    group.orgs.map((org) => {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      return {
        value: { orgID: org.id, accountID: group.account.id, label: org.name },
        label: formatOrgChoiceLabel(group.account, org, isActive),
      }
    }),
  )
  if (opts.length === 0) return yield* println("Байгууллага олдсонгүй")

  yield* Prompt.intro("Байгууллага солих")

  const selected = yield* Prompt.select<OrgChoice>({ message: "Байгууллага сонгоно уу", options: opts })
  if (Option.isNone(selected)) return

  const choice = selected.value
  yield* service.use(choice.accountID, Option.some(choice.orgID))
  yield* Prompt.outro(choice.label + " руу шилжлээ")
})

const orgsEffect = Effect.fn("orgs")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println("Аккаунт олдсонгүй")
  if (!groups.some((group) => group.orgs.length > 0)) return yield* println("Байгууллага олдсонгүй")

  const active = yield* service.active()

  for (const group of groups) {
    for (const org of group.orgs) {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      yield* println(formatOrgLine(group.account, org, isActive))
    }
  }
})

const openEffect = Effect.fn("open")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* println("Идэвхтэй аккаунт алга")

  const url = active.value.url
  yield* openBrowser(url)
  yield* Prompt.outro(url + " нээгдлээ")
})

export const LoginCommand = effectCmd({
  command: "login [url]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "серверийн URL",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.login")(function* (args) {
    UI.empty()
    yield* Effect.orDie(loginEffect(args.url ?? defaultConsoleUrl))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout [email]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("email", {
      describe: "гарах аккаунтын email",
      type: "string",
    }),
  handler: Effect.fn("Cli.account.logout")(function* (args) {
    UI.empty()
    yield* Effect.orDie(logoutEffect(args.email))
  }),
})

export const SwitchCommand = effectCmd({
  command: "switch",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.switch")(function* () {
    UI.empty()
    yield* Effect.orDie(switchEffect())
  }),
})

export const OrgsCommand = effectCmd({
  command: "orgs",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.orgs")(function* () {
    UI.empty()
    yield* Effect.orDie(orgsEffect())
  }),
})

export const OpenCommand = effectCmd({
  command: "open",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.open")(function* () {
    UI.empty()
    yield* Effect.orDie(openEffect())
  }),
})

export const ConsoleCommand = cmd({
  command: "console",
  describe: false,
  builder: (yargs) =>
    yargs
      .command({
        ...LoginCommand,
        describe: "консол руу нэвтрэх",
      })
      .command({
        ...LogoutCommand,
        describe: "консолоос гарах",
      })
      .command({
        ...SwitchCommand,
        describe: "идэвхтэй байгууллага солих",
      })
      .command({
        ...OrgsCommand,
        describe: "байгууллагуудыг жагсаах",
      })
      .command({
        ...OpenCommand,
        describe: "идэвхтэй console аккаунт нээх",
      })
      .demandCommand(),
  async handler() {},
})
