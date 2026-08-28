# @mongolgpt/plugin

MongolGPT-д custom tool, hook болон интеграц нэмэх JavaScript, TypeScript plugin API.

```bash
npm install @mongolgpt/plugin
```

```ts
import type { Plugin } from "@mongolgpt/plugin"

export const MyPlugin: Plugin = async ({ client }) => ({
  event: async ({ event }) => {
    if (event.type === "session.created") {
      await client.app.log({
        body: { service: "my-plugin", level: "info", message: "Сесс үүслээ" },
      })
    }
  },
})
```

Боломжууд болон тохиргооны жишээг [MongolGPT plugin баримт бичгээс](https://docs.mgpt.mn/docs/plugins/) үзнэ үү.

## Лиценз

[MIT](./LICENSE)
