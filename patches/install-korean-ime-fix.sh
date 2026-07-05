#!/usr/bin/env bash
set -euo pipefail

# mongolgpt Korean IME Fix Installer
# https://github.com/sergei10a-rgb/mongolgpt/issues/14371
#
# Patches mongolgpt to prevent Korean (and other CJK) IME last character
# truncation when pressing Enter in Kitty and other terminals.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/claudianus/mongolgpt/fix-zhipuai-coding-plan-thinking/patches/install-korean-ime-fix.sh | bash
#   # or from a cloned repo:
#   ./patches/install-korean-ime-fix.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[38;5;214m'
MUTED='\033[0;2m'
NC='\033[0m'

MONGOLGPT_DIR="${MONGOLGPT_DIR:-$HOME/.mongolgpt}"
MONGOLGPT_SRC="${MONGOLGPT_SRC:-$HOME/.mongolgpt-src}"
FORK_REPO="${FORK_REPO:-https://github.com/claudianus/mongolgpt.git}"
FORK_BRANCH="${FORK_BRANCH:-fix-zhipuai-coding-plan-thinking}"

info()  { echo -e "${MUTED}$*${NC}"; }
warn()  { echo -e "${ORANGE}$*${NC}"; }
err()   { echo -e "${RED}$*${NC}" >&2; }
ok()    { echo -e "${GREEN}$*${NC}"; }

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Error: $1 is required but not installed."
    exit 1
  fi
}

need git
need bun

# â”€â”€ 1. Clone or update fork â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if [ -d "$MONGOLGPT_SRC/.git" ]; then
  info "Updating existing source at $MONGOLGPT_SRC ..."
  git -C "$MONGOLGPT_SRC" fetch origin "$FORK_BRANCH"
  git -C "$MONGOLGPT_SRC" checkout "$FORK_BRANCH"
  git -C "$MONGOLGPT_SRC" reset --hard "origin/$FORK_BRANCH"
else
  info "Cloning fork (shallow) to $MONGOLGPT_SRC ..."
  git clone --depth 1 --branch "$FORK_BRANCH" "$FORK_REPO" "$MONGOLGPT_SRC"
fi

# â”€â”€ 2. Verify the IME fix is present in source â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
PROMPT_FILE="$MONGOLGPT_SRC/packages/mongolgpt/src/cli/cmd/tui/component/prompt/index.tsx"
if [ ! -f "$PROMPT_FILE" ]; then
  err "Prompt file not found: $PROMPT_FILE"
  exit 1
fi

if grep -q "setTimeout(() => setTimeout" "$PROMPT_FILE"; then
  ok "IME fix already present in source."
else
  warn "IME fix not found. Applying patch ..."
  # Apply the fix: replace onSubmit={submit} with double-deferred version
  sed -i 's|onSubmit={submit}|onSubmit={() => {\n                // IME: double-defer so the last composed character (e.g. Korean\n                // hangul) is flushed to plainText before we read it for submission.\n                setTimeout(() => setTimeout(() => submit(), 0), 0)\n              }}|' "$PROMPT_FILE"
  if grep -q "setTimeout(() => setTimeout" "$PROMPT_FILE"; then
    ok "Patch applied."
  else
    err "Failed to apply patch. The source may have changed."
    exit 1
  fi
fi

# â”€â”€ 3. Install dependencies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
info "Installing dependencies (this may take a minute) ..."
cd "$MONGOLGPT_SRC"
bun install --frozen-lockfile 2>/dev/null || bun install

# â”€â”€ 4. Build (current platform only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
info "Building mongolgpt for current platform ..."
cd "$MONGOLGPT_SRC/packages/mongolgpt"
bun run build --single

# â”€â”€ 5. Install binary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
mkdir -p "$MONGOLGPT_DIR/bin"

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
[ "$PLATFORM" = "darwin" ] && true
[ "$PLATFORM" = "linux" ] && true

BUILT_BINARY="$MONGOLGPT_SRC/packages/mongolgpt/dist/mongolgpt-${PLATFORM}-${ARCH}/bin/mongolgpt"

if [ ! -f "$BUILT_BINARY" ]; then
  BUILT_BINARY=$(find "$MONGOLGPT_SRC/packages/mongolgpt/dist" -name "mongolgpt" -type f -executable 2>/dev/null | head -1)
fi

if [ -f "$BUILT_BINARY" ]; then
  if [ -f "$MONGOLGPT_DIR/bin/mongolgpt" ]; then
    cp "$MONGOLGPT_DIR/bin/mongolgpt" "$MONGOLGPT_DIR/bin/mongolgpt.bak.$(date +%Y%m%d%H%M%S)"
  fi
  cp "$BUILT_BINARY" "$MONGOLGPT_DIR/bin/mongolgpt"
  chmod +x "$MONGOLGPT_DIR/bin/mongolgpt"
  ok "Installed to $MONGOLGPT_DIR/bin/mongolgpt"
else
  err "Build failed - binary not found in dist/"
  info "Try running manually:"
  echo "  cd $MONGOLGPT_SRC/packages/mongolgpt && bun run build --single"
  exit 1
fi

echo ""
ok "Done! Korean IME fix is now active."
echo ""
info "To uninstall and revert to the official release:"
echo "  curl -fsSL https://mongolgpt.duckdns.org/install | bash"
echo ""
info "To update (re-pull and rebuild):"
echo "  $0"
