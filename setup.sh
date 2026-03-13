#!/usr/bin/env bash
# Codemaster — local dev setup (run once after cloning)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Setting up Codemaster..."

if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Install from https://nodejs.org"
  exit 1
fi

echo "Installing Node dependencies..."
npm install --silent --no-fund --no-audit

echo ""
echo "✓ Setup complete."
echo ""
echo "Run from your project directory:"
echo "  node $SCRIPT_DIR/bin/codemaster"
echo ""
echo "Or install globally:"
echo "  bash $SCRIPT_DIR/install.sh"
