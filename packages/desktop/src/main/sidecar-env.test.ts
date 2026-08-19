import { describe, expect, test } from "bun:test"

import { createSidecarEnv } from "./sidecar-env"

describe("desktop sidecar environment", () => {
  test("does not propagate the account token encryption key", () => {
    const source = {
      DEBUG: "mongolgpt:*",
      LD_PRELOAD: "/tmp/injected.so",
      MONGOLGPT_ACCOUNT_TOKEN_KEY: "sensitive-key",
      MONGOLGPT_PROVIDER: "openrouter",
    }

    const env = createSidecarEnv(source, { packaged: false, platform: "linux" })

    expect(env).not.toHaveProperty("DEBUG")
    expect(env).not.toHaveProperty("LD_PRELOAD")
    expect(env).not.toHaveProperty("MONGOLGPT_ACCOUNT_TOKEN_KEY")
    expect(env.MONGOLGPT_PROVIDER).toBe("openrouter")
    expect(env.MONGOLGPT_DISABLE_CHANNEL_DB).toBe("1")
    expect(source.MONGOLGPT_ACCOUNT_TOKEN_KEY).toBe("sensitive-key")
  })

  test("keeps packaged platform settings without adding a development override", () => {
    const env = createSidecarEnv({ LD_PRELOAD: "allowed-on-windows" }, { packaged: true, platform: "win32" })

    expect(env.LD_PRELOAD).toBe("allowed-on-windows")
    expect(env).not.toHaveProperty("MONGOLGPT_DISABLE_CHANNEL_DB")
  })
})
