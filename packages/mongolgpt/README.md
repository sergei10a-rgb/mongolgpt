# MongolGPT core

Энэ package нь MongolGPT-ийн terminal agent, server, HTTP API, provider/config, compatibility import logic-ийг агуулна.

## Гол хэсгүүд

- `src/index.ts` - CLI entrypoint
- `src/server/` - local server болон HTTP API
- `src/compat/` - MCP, skill, plugin, connector эх сурвалжийг таньж MongolGPT config-д тааруулах importer
- `src/cli/cmd/compat.ts` - `mongolgpt compat import` CLI command
- `test/compat/` - compatibility importer-ийн regression tests

## Ажиллуулах

Repository root-оос:

```bash
bun install
bun run dev
```

Энэ package дээр шууд typecheck хийх:

```bash
bun --cwd packages/mongolgpt run typecheck
```

Compatibility importer test:

```bash
bun --cwd packages/mongolgpt test test/compat/import.test.ts
```

HTTP API coverage:

```bash
bun --cwd packages/mongolgpt script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip
```

## Интеграц импортлох

Plan хийх:

```bash
mongolgpt compat import plan "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
```

Apply хийх:

```bash
mongolgpt compat import apply "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
```

Importer нь эх сурвалжийн төрлийг автоматаар таньж, шаардлагатай config patch болон plugin wrapper-ийг хэрэглэгчээр гараар бичүүлэхгүйгээр үүсгэхээр бүтээгдсэн.
