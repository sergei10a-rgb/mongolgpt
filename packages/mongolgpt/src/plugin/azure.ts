import type { Hooks, PluginInput } from "@mongolgpt/plugin"

export async function AzureAuthPlugin(_input: PluginInput): Promise<Hooks> {
  const prompts = []
  if (!process.env.AZURE_RESOURCE_NAME) {
    prompts.push({
      type: "text" as const,
      key: "resourceName",
      message: "Azure нөөцийн нэрийг оруулна уу",
      placeholder: "жишээ нь my-models",
    })
  }

  return {
    auth: {
      provider: "azure",
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
