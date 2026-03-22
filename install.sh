#!/usr/bin/env bash
set -e

REPO="https://github.com/Chai-B/CodeMaster.git"
INSTALL_DIR="$HOME/.codemaster"

echo "Installing CodeMaster..."

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo "Removing old install at $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
fi
git clone --depth=1 "$REPO" "$INSTALL_DIR"

cd "$INSTALL_DIR"

# Node deps
npm install --silent

# Make bin executable
chmod +x bin/codemaster

# Link to global bin
npm link

# Python deps (optional — skip if pip not available)
if command -v pip3 &>/dev/null; then
  pip3 install -q -r requirements.txt
elif command -v pip &>/dev/null; then
  pip install -q -r requirements.txt
else
  echo "Warning: pip not found — skipping Python dependencies. Run: pip install -r $INSTALL_DIR/requirements.txt"
fi

echo ""
echo "Done. Run 'codemaster' from any project directory."
