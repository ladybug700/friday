#!/data/data/com.termux/files/usr/bin/bash
# Friday startup script for Termux.
#
# Prereqs (one-time):
#   pkg install nodejs git chromium
#   cd ~/whatsapp-bot && npm install
#
# Set your Ollama Cloud API key once in ~/.bashrc or before this script:
#   export OLLAMA_API_KEY="..."
#
# Then just run:  bash start.sh

set -e
cd "$(dirname "$0")"

# Pin chromium path for puppeteer inside Termux.
export CHROMIUM_PATH="${CHROMIUM_PATH:-/data/data/com.termux/files/usr/bin/chromium-browser}"
export PUPPETEER_EXECUTABLE_PATH="$CHROMIUM_PATH"
export PUPPETEER_SKIP_DOWNLOAD=true

# Sensible defaults — override in your environment if needed.
export OLLAMA_API_KEY="${OLLAMA_API_KEY:-YOUR_OLLAMA_API_KEY_HERE}"
export OLLAMA_HOST="${OLLAMA_HOST:-https://ollama.com}"
export PORT="${PORT:-3000}"

mkdir -p "$HOME/whatsapp-bot/data"

if [ "$OLLAMA_API_KEY" = "YOUR_OLLAMA_API_KEY_HERE" ]; then
  echo "[start.sh] WARNING: OLLAMA_API_KEY is not set. AI replies will fail."
  echo "[start.sh]          export OLLAMA_API_KEY=\"...\" before re-running."
fi

echo "[start.sh] ollama host:    $OLLAMA_HOST"
echo "[start.sh] primary model:  ${PRIMARY_MODEL:-gemma4:31b-cloud}"
echo "[start.sh] fallback model: ${FALLBACK_MODEL:-gpt-oss:120b}"

exec node server.js
