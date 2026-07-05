import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@mongolgpt/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@mongolgpt/core/provider"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "боломжтой бүх загварыг жагсаах",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "загвар шүүх provider ID",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "загварын дэлгэрэнгүй гаралт ашиглах (өртөг зэрэг metadata орно)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "загварын cache-ийг models.dev-ээс шинэчлэх",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => {
      const aIsMongolGPT = a.startsWith("mongolgpt")
      const bIsMongolGPT = b.startsWith("mongolgpt")
      if (aIsMongolGPT && !bIsMongolGPT) return -1
      if (!aIsMongolGPT && bIsMongolGPT) return 1
      return a.localeCompare(b)
    })

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})
