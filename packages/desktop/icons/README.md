# MongolGPT ширээний аппын дүрс

Canonical эх зураг нь `packages/identity/mark.svg`.

```bash
bun run brand:generate
```

Энэ команд `dev`, `beta`, `prod` сувгийн PNG болон Windows ICO файлуудыг, мөн Web/PWA favicon-уудыг нэг эх зургаас дахин үүсгэнэ. macOS багцлалтын үед Electron Builder `icon.svg`-ээс ICNS-ийг тухайн runner дээр үүсгэнэ. Generated файлыг гараар засахгүй.

```bash
bun run brand:check
```

Энэ шалгалт canonical source болон tracked output хооронд зөрүү байгаа эсэхийг файл өөрчлөхгүйгээр шалгана.
