#!/usr/bin/env bash
# Codemaster — one-command global installer
#
# Via curl (fresh install):
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/codemaster/main/install.sh | bash
#
# From a cloned repo:
#   bash install.sh
#
set -euo pipefail

INSTALL_DIR="$HOME/.codemaster"
REPO_URL="https://github.com/Chai-B/CodeMaster"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
die()  { echo -e "${RED}✗${RESET} $*"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo "  ▄████▄   CodeMaster installer"
echo "  ██       "
echo "  ▀████▀   AI coding assistant for your terminal"
echo ""

# ── Prereq checks ─────────────────────────────────────────────────────────────
command -v python3 &>/dev/null || die "Python 3.10+ is required. https://python.org"
PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' \
  || die "Python 3.10+ required (found $PY_VERSION)"

command -v node &>/dev/null || die "Node.js 18+ is required. https://nodejs.org"
command -v npm  &>/dev/null || die "npm is required (comes with Node.js)"

if ! command -v claude &>/dev/null; then
  warn "Claude Code CLI not found. Install it first:"
  warn "  https://claude.ai/code"
  warn "Continuing install — you'll need it before running Codemaster."
fi

# ── Locate or clone source ────────────────────────────────────────────────────
# When piped from curl, BASH_SOURCE[0] is empty — we must clone.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_PATH" ] && [ -f "$(dirname "$SCRIPT_PATH")/codemaster.py" ]; then
  SRC="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  echo "Installing from local source: $SRC"
else
  echo "Cloning Codemaster..."
  TMP_DIR="$(mktemp -d)"
  git clone --depth=1 "$REPO_URL" "$TMP_DIR/codemaster" \
    || die "Clone failed. Check your internet connection or clone manually."
  SRC="$TMP_DIR/codemaster"
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "Installing to $INSTALL_DIR ..."
rm -rf "$INSTALL_DIR"
cp -r "$SRC" "$INSTALL_DIR"

cd "$INSTALL_DIR"
echo "Installing Node dependencies..."
npm install --silent --no-fund --no-audit

# ── Link binary ───────────────────────────────────────────────────────────────
chmod +x "$INSTALL_DIR/bin/codemaster"

LINK="/usr/local/bin/codemaster"
if [ -w "/usr/local/bin" ]; then
  ln -sf "$INSTALL_DIR/bin/codemaster" "$LINK"
else
  sudo ln -sf "$INSTALL_DIR/bin/codemaster" "$LINK"
fi
ok "Linked to $LINK"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
ok "Codemaster installed successfully!"
echo ""
echo "  Usage: cd into any project, then run:"
echo ""
echo "    codemaster"
echo ""
echo "  Requirements:"
echo "    · Python 3.10+           ✓ ($PY_VERSION detected)"
if command -v claude &>/dev/null; then
echo "    · Claude Code CLI        ✓ ($(claude --version 2>/dev/null | head -1 || echo 'detected'))"
else
echo "    · Claude Code CLI        ✗ install from https://claude.ai/code"
fi
echo "    · Optional: ruff, flake8, isort  (pip install ruff flake8 isort)"
echo ""
