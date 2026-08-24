#!/usr/bin/env bash
# CodeMaster Next — one-command installer.
# Usage (from a clone):   ./install.sh
# Or remote one-liner:
#   curl -fsSL https://raw.githubusercontent.com/Chai-B/CodeMaster/main/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/Chai-B/CodeMaster.git"

# Resolve the project directory: the script's own dir if it lives in the repo,
# otherwise clone fresh (supports the curl|bash path).
if [ -f "$(dirname "$0")/package.json" ]; then
  DIR="$(cd "$(dirname "$0")" && pwd)"
else
  DIR="${CODEMASTER_DIR:-$HOME/.codemaster-next}"
  echo "▸ Cloning CodeMaster into $DIR"
  rm -rf "$DIR"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi
cd "$DIR"

command -v node >/dev/null 2>&1 || { echo "✗ Node.js 20+ is required. Install it first."; exit 1; }

echo "▸ Installing dependencies"
npm install --omit=dev --no-audit --no-fund

# Remove any previous global `codemaster` so the new one takes over.
if command -v codemaster >/dev/null 2>&1; then
  OLD="$(command -v codemaster)"
  echo "▸ Removing previous codemaster at $OLD"
  npm uninstall -g codemaster >/dev/null 2>&1 || true
  npm uninstall -g codemaster-next >/dev/null 2>&1 || true
  # Stale symlink left behind by another package manager (e.g. Homebrew node).
  [ -L "$OLD" ] && rm -f "$OLD" 2>/dev/null || true
fi

echo "▸ Linking global \`codemaster\` command"
npm install -g . --no-audit --no-fund

echo ""
echo "✓ Installed. Launch with:  codemaster"
echo "  Credentials: set ANTHROPIC_API_KEY, or run \`claude setup-token\` for account login."
