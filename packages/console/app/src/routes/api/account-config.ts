const tokenReference = "{env:MONGOLGPT_CONSOLE_TOKEN}"

export function selectAccountWorkspace(rows: ReadonlyArray<{ workspaceID: string }>, organizationRequested: boolean) {
  if (rows.length === 0) return { status: "forbidden" as const }
  if (!organizationRequested && rows.length > 1) return { status: "organization-required" as const }
  return { status: "selected" as const, workspaceID: rows[0].workspaceID }
}

export function createAccountConfig(input: { origin: string; workspaceID: string }) {
  const api = `${input.origin.replace(/\/+$/, "")}/gateway/v1`
  return {
    provider: {
      mongolgpt: {
        id: "mongolgpt",
        name: "MongolGPT",
        npm: "@ai-sdk/openai-compatible",
        api,
        env: ["MONGOLGPT_CONSOLE_TOKEN"],
        options: {
          apiKey: tokenReference,
          baseURL: api,
          headers: { "x-org-id": input.workspaceID },
        },
        models: {
          "free-auto": {
            id: "free-auto",
            name: "MongolGPT Free Auto",
            family: "auto",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 128_000, output: 16_384 },
            modalities: { input: ["text"], output: ["text"] },
            status: "active",
          },
          "openrouter-byok": {
            id: "openrouter-byok",
            name: "OpenRouter (өөрийн түлхүүр)",
            family: "openrouter",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
            status: "active",
          },
          "nvidia-nim-byok": {
            id: "nvidia-nim-byok",
            name: "NVIDIA NIM (өөрийн түлхүүр)",
            family: "nvidia",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            cost: { input: 0, output: 0 },
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
            status: "active",
          },
        },
      },
    },
  }
}
