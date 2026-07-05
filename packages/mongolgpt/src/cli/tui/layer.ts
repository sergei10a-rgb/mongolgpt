import { run as runTui, type TuiInput } from "@mongolgpt/tui"
import { Global } from "@mongolgpt/core/global"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(Global.defaultLayer))
}
