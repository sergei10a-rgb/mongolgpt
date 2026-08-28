# @mongolgpt/sdk

MongolGPT сервертэй төрөл аюулгүй JavaScript болон TypeScript клиентээр ажиллах албан ёсны SDK.

```bash
npm install @mongolgpt/sdk
```

```ts
import { createMongolGPTClient } from "@mongolgpt/sdk"

const client = createMongolGPTClient({
  baseUrl: "http://localhost:4096",
})

const sessions = await client.session.list()
```

Суулгалт, нэвтрэлт болон API-ийн дэлгэрэнгүйг [MongolGPT SDK баримт бичгээс](https://docs.mgpt.mn/docs/sdk/) үзнэ үү.

## Лиценз

[MIT](./LICENSE)
