import { expect, test } from "bun:test"

function config(env: Record<string, string>) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `const config = (await import(${JSON.stringify(new URL("../playwright.config.ts", import.meta.url).href)})).default;
console.log(JSON.stringify({
  api: process.env.PLAYWRIGHT_SERVER_PORT,
  buildAPI: config.webServer.env.VITE_MONGOLGPT_SERVER_PORT,
  ui: config.webServer.url,
}));`,
    ],
    {
      env: {
        ...process.env,
        PLAYWRIGHT_PORT: undefined,
        PLAYWRIGHT_BASE_URL: undefined,
        PLAYWRIGHT_SERVER_PORT: undefined,
        ...env,
      },
    },
  )
}

for (const input of [
  { env: {}, port: "3000", api: "3001" },
  { env: { PLAYWRIGHT_PORT: "4450" }, port: "4450", api: "4451" },
  { env: { PLAYWRIGHT_PORT: "4450", PLAYWRIGHT_SERVER_PORT: "4452" }, port: "4450", api: "4452" },
]) {
  test(`production benchmark UI ${input.port} and mock API ${input.api} stay aligned`, () => {
    const result = config(input.env)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      api: input.api,
      buildAPI: input.api,
      ui: `http://127.0.0.1:${input.port}`,
    })
  })
}

test("rejects a production benchmark that points its API at the static UI", () => {
  const result = config({ PLAYWRIGHT_PORT: "4450", PLAYWRIGHT_SERVER_PORT: "4450" })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("Performance UI and mock API must use different ports")
})
