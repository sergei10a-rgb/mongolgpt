import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Keep module-level Global setup inside an isolated directory for each test worker.
const root = mkdtempSync(join(tmpdir(), "mongolgpt-tui-test-"))
const config = join(root, "config")
const data = join(root, "data")
const cache = join(root, "cache")
const state = join(root, "state")
const home = join(root, "home")

process.env.XDG_CONFIG_HOME = config
process.env.XDG_DATA_HOME = data
process.env.XDG_CACHE_HOME = cache
process.env.XDG_STATE_HOME = state
process.env.MONGOLGPT_TEST_HOME = home

for (const directory of [
  join(config, "mongolgpt"),
  join(data, "mongolgpt"),
  join(cache, "mongolgpt"),
  join(state, "mongolgpt"),
  home,
]) {
  mkdirSync(directory, { recursive: true })
}

process.once("exit", () => {
  rmSync(root, { recursive: true, force: true })
})
