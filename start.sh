#!/data/data/com.termux/files/usr/bin/bash
# Friday startup script for Termux.
#
# Prereqs (one-time):
#   pkg install nodejs git chromium
#   cd ~/whatsapp-bot && npm install
#
# Set your OpenCode API key once in ~/.bashrc or before this script:
#   export OPENCODE_API_KEY="sk-..."
#
# Then just run:  bash start.sh

set -e
cd "$(dirname "$0")"

# Pin chromium path for puppeteer inside Termux.
export CHROMIUM_PATH="${CHROMIUM_PATH:-/data/data/com.termux/files/usr/bin/chromium-browser}"
export PUPPETEER_EXECUTABLE_PATH="$CHROMIUM_PATH"
export PUPPETEER_SKIP_DOWNLOAD=true

# Sensible defaults — override in your environment if needed.
export OPENCODE_API_KEY="${OPENCODE_API_KEY:-YOUR_OPENCODE_API_KEY_HERE}"
export PORT="${PORT:-3000}"

mkdir -p "$HOME/whatsapp-bot/data"

if [ "$OPENCODE_API_KEY" = "YOUR_OPENCODE_API_KEY_HERE" ]; then
  echo "[start.sh] WARNING: OPENCODE_API_KEY is not set. AI replies will fail."
  echo "[start.sh]          export OPENCODE_API_KEY=\"sk-...\" before re-running."
fi

exec node server.js
