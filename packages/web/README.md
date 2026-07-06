# MongolGPT docs

Энэ package нь [mongolgpt.duckdns.org/docs](https://mongolgpt.duckdns.org/docs/) дээрх active Starlight docs site-ийн source юм.

## Хаана юу байдаг вэ

- `src/content/docs/` - `/docs/` дээр гарах үндсэн Монгол баримт бичиг
- `src/content/docs/mn/` - хуучин `/docs/mn/` холбоосын нийцтэй Монгол хуулбар
- `astro.config.mjs` - Starlight sidebar, locale, theme тохиргоо
- `public/` - docs site static assets

`packages/docs/` дотор байсан Mintlify starter template-ийг repo-оос хассан. MongolGPT-ийн идэвхтэй docs source нь энэ package.

## Local дээр ажиллуулах

Repository root-оос:

```bash
bun run dev:docs
```

Энэ package дотроос:

```bash
bun --cwd packages/web dev
```

Build шалгах:

```bash
bun run build:docs
```

## Монгол docs бичих зарчим

- Монгол хэрэглэгчид шууд ойлгох хэллэг ашиглана.
- Нийтлэгдээгүй package, installer, marketplace зүйлийг ажиллаж байгаа мэт бичихгүй.
- Command, config key, package name, URL-ийг орчуулалгүй үлдээнэ.
- Compatibility эсвэл legacy alias-ыг зөвхөн шаардлагатай үед “хуучин тохиргооны нийцтэй байдал” гэж тайлбарлана.

## Гол холбоосууд

- Монгол docs: [https://mongolgpt.duckdns.org/docs/](https://mongolgpt.duckdns.org/docs/)
- Releases: [https://github.com/sergei10a-rgb/mongolgpt/releases](https://github.com/sergei10a-rgb/mongolgpt/releases)
- Source: [https://github.com/sergei10a-rgb/mongolgpt](https://github.com/sergei10a-rgb/mongolgpt)
