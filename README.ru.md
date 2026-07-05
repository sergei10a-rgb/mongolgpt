<p align="center">
  <a href="https://mongolgpt.duckdns.org">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="MongolGPT logo">
    </picture>
  </a>
</p>
<p align="center">Открытый AI-агент для программирования.</p>
<p align="center">
  <a href="https://mongolgpt.duckdns.org/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/mongolgpt"><img alt="npm" src="https://img.shields.io/npm/v/mongolgpt?style=flat-square" /></a>
  <a href="https://github.com/sergei10a-rgb/mongolgpt/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/sergei10a-rgb/mongolgpt/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a> |
  <a href="README.mn.md">??????</a>
</p>

[![MongolGPT Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://mongolgpt.duckdns.org)

---

### Установка

```bash
# YOLO
curl -fsSL https://mongolgpt.duckdns.org/install | bash

# Менеджеры пакетов
npm i -g mongolgpt@latest        # или bun/pnpm/yarn
scoop install mongolgpt             # Windows
choco install mongolgpt             # Windows
brew install sergei10a-rgb/tap/mongolgpt # macOS и Linux (рекомендуем, всегда актуально)
brew install mongolgpt              # macOS и Linux (официальная формула brew, обновляется реже)
sudo pacman -S mongolgpt            # Arch Linux (Stable)
paru -S mongolgpt-bin               # Arch Linux (Latest from AUR)
mise use -g mongolgpt               # любая ОС
nix run nixpkgs#mongolgpt           # или github:sergei10a-rgb/mongolgpt для самой свежей ветки dev
```

> [!TIP]
> Перед установкой удалите версии старше 0.1.x.

### Десктопное приложение (BETA)

MongolGPT также доступен как десктопное приложение. Скачайте его со [страницы релизов](https://github.com/sergei10a-rgb/mongolgpt/releases) или с [mongolgpt.duckdns.org/download](https://mongolgpt.duckdns.org/download).

| Платформа             | Загрузка                            |
| --------------------- | ----------------------------------- |
| macOS (Apple Silicon) | `mongolgpt-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `mongolgpt-desktop-mac-x64.dmg`     |
| Windows               | `mongolgpt-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` или AppImage         |

```bash
# macOS (Homebrew)
brew install --cask mongolgpt-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/mongolgpt-desktop
```

#### Каталог установки

Скрипт установки выбирает путь установки в следующем порядке приоритета:

1. `$MONGOLGPT_INSTALL_DIR` - Пользовательский каталог установки
2. `$XDG_BIN_DIR` - Путь, совместимый со спецификацией XDG Base Directory
3. `$HOME/bin` - Стандартный каталог пользовательских бинарников (если существует или можно создать)
4. `$HOME/.mongolgpt/bin` - Fallback по умолчанию

```bash
# Примеры
MONGOLGPT_INSTALL_DIR=/usr/local/bin curl -fsSL https://mongolgpt.duckdns.org/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://mongolgpt.duckdns.org/install | bash
```

### Agents

В MongolGPT есть два встроенных агента, между которыми можно переключаться клавишей `Tab`.

- **build** - По умолчанию, агент с полным доступом для разработки
- **plan** - Агент только для чтения для анализа и изучения кода
  - По умолчанию запрещает редактирование файлов
  - Запрашивает разрешение перед выполнением bash-команд
  - Идеален для изучения незнакомых кодовых баз или планирования изменений

Также включен сабагент **general** для сложных поисков и многошаговых задач.
Он используется внутренне и может быть вызван в сообщениях через `@general`.

Подробнее об [agents](https://mongolgpt.duckdns.org/docs/agents).

### Документация

Больше информации о том, как настроить MongolGPT: [**наши docs**](https://mongolgpt.duckdns.org/docs).

### Вклад

Если вы хотите внести вклад в MongolGPT, прочитайте [contributing docs](./CONTRIBUTING.md) перед тем, как отправлять pull request.

### Разработка на базе MongolGPT

Если вы делаете проект, связанный с MongolGPT, и используете "mongolgpt" как часть имени (например, "mongolgpt-dashboard" или "mongolgpt-mobile"), добавьте примечание в README, чтобы уточнить, что проект не создан командой MongolGPT и не аффилирован с нами.

---

**Присоединяйтесь к нашему сообществу** [Discord](https://discord.gg/mongolgpt) | [X.com](https://x.com/mongolgpt)
