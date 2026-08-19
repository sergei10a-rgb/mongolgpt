import type { Hooks, PluginInput } from "@mongolgpt/plugin"

export async function CloudflareWorkersAuthPlugin(_input: PluginInput): Promise<Hooks> {
  const prompts = !process.env.CLOUDFLARE_ACCOUNT_ID
    ? [
        {
          type: "text" as const,
          key: "accountId",
          message: "Cloudflare аккаунтын ID-гаа оруулна уу",
          placeholder: "жишээ нь 1234567890abcdef1234567890abcdef",
        },
      ]
    : []

  return {
    auth: {
      provider: "cloudflare-workers-ai",
      methods: [
        {
          type: "api",
          label: "API түлхүүр",
          prompts,
        },
      ],
    },
  }
}

export async function CloudflareAIGatewayAuthPlugin(_input: PluginInput): Promise<Hooks> {
  const prompts = [
    ...(!process.env.CLOUDFLARE_ACCOUNT_ID
      ? [
          {
            type: "text" as const,
            key: "accountId",
            message: "Cloudflare аккаунтын ID-гаа оруулна уу",
            placeholder: "жишээ нь 1234567890abcdef1234567890abcdef",
          },
        ]
      : []),
    ...(!process.env.CLOUDFLARE_GATEWAY_ID
      ? [
          {
            type: "text" as const,
            key: "gatewayId",
            message: "Cloudflare AI Gateway-ийн ID-гаа оруулна уу",
            placeholder: "жишээ нь my-gateway",
          },
        ]
      : []),
  ]

  return {
    auth: {
      provider: "cloudflare-ai-gateway",
      methods: [
        {
          type: "api",
          label: "Gateway-ийн API токен",
          prompts,
        },
      ],
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "cloudflare-ai-gateway") return
      // The unified gateway routes through @ai-sdk/openai-compatible, which
      // always emits max_tokens. OpenAI reasoning models (gpt-5.x, o-series)
      // reject that field and require max_completion_tokens instead, and the
      // compatible SDK has no way to rename it. Drop the cap so OpenAI falls
      // back to the model's default output budget.
      if (!input.model.api.id.toLowerCase().startsWith("openai/")) return
      if (!input.model.capabilities.reasoning) return
      output.maxOutputTokens = undefined
    },
  }
}
