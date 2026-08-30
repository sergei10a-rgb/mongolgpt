# CI контейнерууд

GitHub Actions-ийн том, суулгахад удаан хамаарлуудыг урьдчилан шингээж, ажлын хугацааг багасгахад зориулсан бэлэн контейнерийн дүрсүүд. Эдгээр нь ажлын урсгалдаа `job.container` ашиглах боломжтой Linux ажлуудад зориулагдсан.

## Дүрсүүд

- `base`: түгээмэл бүтээх хэрэгсэл болон хэрэглүүртэй Ubuntu 24.04
- `bun-node`: `base` дээр Bun болон Node.js 24 нэмсэн
- `rust`: `bun-node` дээр Rust (stable, minimal profile) нэмсэн
- `tauri-linux`: `rust` дээр Tauri-ийн Linux бүтээх хамаарлуудыг нэмсэн
- `publish`: `bun-node` дээр Docker CLI болон AUR хэрэгслүүд нэмсэн

## Бүтээх

```sh
REGISTRY=ghcr.io/sergei10a-rgb TAG=24.04 bun ./packages/containers/script/build.ts
REGISTRY=ghcr.io/sergei10a-rgb TAG=24.04 bun ./packages/containers/script/build.ts --push
```

## Ажлын урсгалд ашиглах

```yaml
jobs:
  build-cli:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/sergei10a-rgb/build/bun-node:24.04
```

## Тэмдэглэл

- Эдгээр дүрс зөвхөн Linux ажилд тусална. macOS болон Windows ажлууд Linux контейнер дотор ажиллахгүй.
- `--push` нь Buildx ашиглан олон архитектурт (`amd64` + `arm64`) зориулсан дүрсийг нийтэлнэ.
- Хэрэв ажил Docker Buildx ашиглавал контейнер үндсэн машины Docker daemon-д хандах эрхтэй байх ёстой. Эсвэл давуу эрхийн горимтой `docker-in-docker` ашиглана.
