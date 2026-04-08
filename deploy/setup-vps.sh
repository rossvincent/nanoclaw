#!/bin/bash
# Kensho VPS Deploy Script
# Run this on a fresh Hetzner CX22 (Ubuntu 24.04)
# Usage: curl -sL <raw-url> | bash -s -- --telegram-token "YOUR_TOKEN" --anthropic-key "YOUR_KEY"
#
# Or clone the repo and run:
#   ./deploy/setup-vps.sh --telegram-token "YOUR_TOKEN" --anthropic-key "YOUR_KEY"

set -euo pipefail

# --- Parse arguments ---
TELEGRAM_BOT_TOKEN=""
ANTHROPIC_API_KEY=""
OAUTH_TOKEN=""
ASSISTANT_NAME="Kensho"
INSTANCE_NAME="kensho"
PROXY_PORT="3002"
CHAT_JID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --telegram-token) TELEGRAM_BOT_TOKEN="$2"; shift 2;;
    --anthropic-key) ANTHROPIC_API_KEY="$2"; shift 2;;
    --oauth-token) OAUTH_TOKEN="$2"; shift 2;;
    --name) ASSISTANT_NAME="$2"; shift 2;;
    --instance) INSTANCE_NAME="$2"; shift 2;;
    --proxy-port) PROXY_PORT="$2"; shift 2;;
    --chat-jid) CHAT_JID="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
  echo "ERROR: --telegram-token is required"
  exit 1
fi

if [[ -z "$ANTHROPIC_API_KEY" && -z "$OAUTH_TOKEN" ]]; then
  echo "ERROR: either --anthropic-key or --oauth-token is required"
  exit 1
fi

echo "=== Kensho VPS Setup ==="
echo "Instance: $INSTANCE_NAME"
echo "Assistant: $ASSISTANT_NAME"
echo "Proxy port: $PROXY_PORT"
echo ""

# --- 1. System packages ---
echo ">>> Installing system packages..."
apt-get update -qq
apt-get install -y -qq git curl build-essential sqlite3 > /dev/null

# --- 2. Node.js 22 ---
if ! command -v node &> /dev/null || [[ "$(node -v)" != v22* ]]; then
  echo ">>> Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
fi
echo "Node: $(node -v)"

# --- 3. Docker ---
if ! command -v docker &> /dev/null; then
  echo ">>> Installing Docker..."
  curl -fsSL https://get.docker.com | sh > /dev/null 2>&1
fi
systemctl enable docker --now > /dev/null 2>&1
echo "Docker: $(docker --version)"

# --- 4. Create nanoclaw user ---
if ! id nanoclaw &>/dev/null; then
  echo ">>> Creating nanoclaw user..."
  useradd -m -s /bin/bash nanoclaw
  usermod -aG docker nanoclaw
fi

INSTALL_DIR="/home/nanoclaw/$INSTANCE_NAME"
HOME_DIR="/home/nanoclaw"

# --- 5. Clone NanoClaw ---
echo ">>> Setting up $INSTANCE_NAME..."
if [[ -d "$INSTALL_DIR" ]]; then
  echo "Directory exists, pulling latest..."
  sudo -u nanoclaw git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || true
else
  sudo -u nanoclaw git clone https://github.com/rossvincent/nanoclaw.git "$INSTALL_DIR"
fi

# --- 6. Copy Telegram channel if not present ---
if [[ ! -f "$INSTALL_DIR/src/channels/telegram.ts" ]]; then
  echo ">>> Telegram channel not in repo yet – please ensure it's been pushed or copy manually"
  echo "    For now, the local files should be pushed to the repo first."
fi

# --- 7. Remove WhatsApp import (Kensho is Telegram-only) ---
CHANNEL_INDEX="$INSTALL_DIR/src/channels/index.ts"
if grep -q "import './whatsapp.js'" "$CHANNEL_INDEX" 2>/dev/null; then
  sed -i "s|import './whatsapp.js';|// whatsapp (not used)|" "$CHANNEL_INDEX"
  echo ">>> Disabled WhatsApp channel import"
fi

# --- 8. Install dependencies and build ---
echo ">>> Installing dependencies..."
cd "$INSTALL_DIR"
sudo -u nanoclaw npm install --ignore-scripts > /dev/null 2>&1
echo ">>> Building TypeScript..."
sudo -u nanoclaw npm run build > /dev/null 2>&1

# --- 9. Build agent container ---
echo ">>> Building agent container (this takes a few minutes)..."
cd "$INSTALL_DIR/container"
docker build -t nanoclaw-agent:latest . 2>&1 | tail -1

# --- 10. Write .env ---
echo ">>> Writing .env..."
cat > "$INSTALL_DIR/.env" << ENVEOF
ASSISTANT_NAME="$ASSISTANT_NAME"
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
CREDENTIAL_PROXY_PORT=$PROXY_PORT
ENVEOF

if [[ -n "$ANTHROPIC_API_KEY" ]]; then
  echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> "$INSTALL_DIR/.env"
fi
if [[ -n "$OAUTH_TOKEN" ]]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_TOKEN" >> "$INSTALL_DIR/.env"
fi

chown nanoclaw:nanoclaw "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

# --- 11. Mount allowlist ---
echo ">>> Configuring mount allowlist..."
mkdir -p "$HOME_DIR/.config/nanoclaw"
cat > "$HOME_DIR/.config/nanoclaw/mount-allowlist.json" << 'MOUNTEOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
MOUNTEOF
chown -R nanoclaw:nanoclaw "$HOME_DIR/.config/nanoclaw"

# --- 12. Register Telegram chat (if JID provided) ---
if [[ -n "$CHAT_JID" ]]; then
  echo ">>> Registering chat $CHAT_JID as main group..."
  cd "$INSTALL_DIR"
  sudo -u nanoclaw npx tsx setup/index.ts --step register \
    --jid "$CHAT_JID" \
    --name "Ross" \
    --trigger "@$ASSISTANT_NAME" \
    --folder "main" \
    --channel "telegram" \
    --no-trigger-required \
    --is-main \
    --assistant-name "$ASSISTANT_NAME"
fi

# --- 13. Ensure config.ts reads CREDENTIAL_PROXY_PORT from .env ---
CONFIG_FILE="$INSTALL_DIR/src/config.ts"
if ! grep -q "CREDENTIAL_PROXY_PORT" <(grep "readEnvFile" "$CONFIG_FILE"); then
  echo ">>> Patching config.ts to read CREDENTIAL_PROXY_PORT from .env..."
  sed -i "s/readEnvFile(\['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER'\])/readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'CREDENTIAL_PROXY_PORT'])/" "$CONFIG_FILE"
  sed -i "s/process.env.CREDENTIAL_PROXY_PORT || '3001'/process.env.CREDENTIAL_PROXY_PORT || envConfig.CREDENTIAL_PROXY_PORT || '3001'/" "$CONFIG_FILE"
  cd "$INSTALL_DIR"
  sudo -u nanoclaw npm run build > /dev/null 2>&1
fi

# --- 14. Create systemd service ---
echo ">>> Creating systemd service..."
cat > "/etc/systemd/system/nanoclaw-${INSTANCE_NAME}.service" << SVCEOF
[Unit]
Description=NanoClaw ($INSTANCE_NAME)
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=nanoclaw
Group=nanoclaw
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/dist/index.js
Restart=always
RestartSec=10
Environment=HOME=$HOME_DIR
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nanoclaw-$INSTANCE_NAME

# Security
NoNewPrivileges=false
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR $HOME_DIR/.config/nanoclaw /var/run/docker.sock
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "nanoclaw-${INSTANCE_NAME}" > /dev/null 2>&1

# --- 15. Start the service ---
echo ">>> Starting $INSTANCE_NAME..."
systemctl start "nanoclaw-${INSTANCE_NAME}"
sleep 3

if systemctl is-active --quiet "nanoclaw-${INSTANCE_NAME}"; then
  echo ""
  echo "=== $INSTANCE_NAME is LIVE ==="
  echo ""
  echo "Service: nanoclaw-${INSTANCE_NAME}"
  echo "Status:  systemctl status nanoclaw-${INSTANCE_NAME}"
  echo "Logs:    journalctl -u nanoclaw-${INSTANCE_NAME} -f"
  echo "Restart: systemctl restart nanoclaw-${INSTANCE_NAME}"
  echo ""
  if [[ -z "$CHAT_JID" ]]; then
    echo "NEXT STEP: Send a message to your bot on Telegram, then run:"
    echo "  journalctl -u nanoclaw-${INSTANCE_NAME} --no-pager -n 20"
    echo ""
    echo "Find your chat JID in the logs, then register it:"
    echo "  cd $INSTALL_DIR && sudo -u nanoclaw npx tsx setup/index.ts --step register \\"
    echo "    --jid 'tg:YOUR_CHAT_ID' --name 'Ross' --trigger '@$ASSISTANT_NAME' \\"
    echo "    --folder 'main' --channel 'telegram' --no-trigger-required --is-main \\"
    echo "    --assistant-name '$ASSISTANT_NAME'"
    echo ""
    echo "Then restart: systemctl restart nanoclaw-${INSTANCE_NAME}"
  fi
else
  echo "ERROR: Service failed to start. Check logs:"
  echo "  journalctl -u nanoclaw-${INSTANCE_NAME} --no-pager -n 30"
  exit 1
fi
