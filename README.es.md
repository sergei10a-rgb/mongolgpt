<p align="center">
  <a href="https://mongolgpt.duckdns.org">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="MongolGPT logo">
    </picture>
  </a>
</p>
<p align="center">El agente de programación con IA de código abierto.</p>
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

### Instalación

```bash
# YOLO
curl -fsSL https://mongolgpt.duckdns.org/install | bash

# Gestores de paquetes
npm i -g mongolgpt@latest        # o bun/pnpm/yarn
scoop install mongolgpt             # Windows
choco install mongolgpt             # Windows
brew install sergei10a-rgb/tap/mongolgpt # macOS y Linux (recomendado, siempre al día)
brew install mongolgpt              # macOS y Linux (fórmula oficial de brew, se actualiza menos)
sudo pacman -S mongolgpt            # Arch Linux (Stable)
paru -S mongolgpt-bin               # Arch Linux (Latest from AUR)
mise use -g mongolgpt               # cualquier sistema
nix run nixpkgs#mongolgpt           # o github:sergei10a-rgb/mongolgpt para la rama dev más reciente
```

> [!TIP]
> Elimina versiones anteriores a 0.1.x antes de instalar.

### App de escritorio (BETA)

MongolGPT también está disponible como aplicación de escritorio. Descárgala directamente desde la [página de releases](https://github.com/sergei10a-rgb/mongolgpt/releases) o desde [mongolgpt.duckdns.org/download](https://mongolgpt.duckdns.org/download).

| Plataforma            | Descarga                            |
| --------------------- | ----------------------------------- |
| macOS (Apple Silicon) | `mongolgpt-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `mongolgpt-desktop-mac-x64.dmg`     |
| Windows               | `mongolgpt-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, o AppImage          |

```bash
# macOS (Homebrew)
brew install --cask mongolgpt-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/mongolgpt-desktop
```

#### Directorio de instalación

El script de instalación respeta el siguiente orden de prioridad para la ruta de instalación:

1. `$MONGOLGPT_INSTALL_DIR` - Directorio de instalación personalizado
2. `$XDG_BIN_DIR` - Ruta compatible con la especificación XDG Base Directory
3. `$HOME/bin` - Directorio binario estándar del usuario (si existe o se puede crear)
4. `$HOME/.mongolgpt/bin` - Alternativa por defecto

```bash
# Ejemplos
MONGOLGPT_INSTALL_DIR=/usr/local/bin curl -fsSL https://mongolgpt.duckdns.org/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://mongolgpt.duckdns.org/install | bash
```

### Agentes

MongolGPT incluye dos agentes integrados que puedes alternar con la tecla `Tab`.

- **build** - Por defecto, agente con acceso completo para tareas de desarrollo
- **plan** - Agente de solo lectura para análisis y exploración de código
  - Deniega ediciones de archivos por defecto
  - Pide permiso antes de ejecutar comandos bash
  - Ideal para explorar codebases desconocidas o planificar cambios

Además, incluye un subagente **general** para búsquedas complejas y tareas de varios pasos.
Se usa internamente y se puede invocar con `@general` en los mensajes.

Más información sobre [agentes](https://mongolgpt.duckdns.org/docs/agents).

### Documentación

Para más información sobre cómo configurar MongolGPT, [**ve a nuestra documentación**](https://mongolgpt.duckdns.org/docs).

### Contribuir

Si te interesa contribuir a MongolGPT, lee nuestras [docs de contribución](./CONTRIBUTING.md) antes de enviar un pull request.

### Proyectos basados en MongolGPT

Si estás trabajando en un proyecto basado en MongolGPT y usas "mongolgpt" como parte del nombre, por ejemplo, "mongolgpt-dashboard" u "mongolgpt-mobile", agrega una nota en tu README para aclarar que no está hecho por el equipo de MongolGPT y que no está afiliado con nosotros de ninguna manera.

---

**Únete a nuestra comunidad** [Discord](https://discord.gg/mongolgpt) | [X.com](https://x.com/mongolgpt)
