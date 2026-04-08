# Deploying Kensho (and Barky) to Hetzner

## 1. Create the server

1. Go to [console.hetzner.cloud](https://console.hetzner.cloud)
2. Create a project (e.g. "NanoClaw")
3. Add a server:
   - **Location:** Falkenstein (fsn1) or Nuremberg (nbg1) – cheapest EU
   - **Image:** Ubuntu 24.04
   - **Type:** CX22 (2 vCPU, 4GB RAM, 40GB disk) – €4.50/mo
   - **SSH key:** Add your public key (`cat ~/.ssh/id_ed25519.pub` or `cat ~/.ssh/id_rsa.pub`)
   - If you don't have one: `ssh-keygen -t ed25519` then add the .pub contents
4. Create. Note the IP address.

## 2. First-time setup

SSH into the server:

```bash
ssh root@YOUR_SERVER_IP
```

### Before you run the script

You need either:
- An **Anthropic API key** (from console.anthropic.com) – simplest option, OR
- Your **OAuth token** (what you use locally)

The OAuth token from your Mac is in your local `.env`:
```bash
# On your Mac, run:
cat ~/nanoclaw/.env | grep OAUTH
```

### Push the Telegram channel to your repo first

The deploy script clones from GitHub, so the Telegram channel needs to be there:

```bash
# On your Mac:
cd ~/nanoclaw
git add src/channels/telegram.ts src/channels/telegram.test.ts src/channels/index.ts
git commit -m "Add Telegram channel adapter"
git push
```

### Run the deploy

```bash
# On the server:
git clone https://github.com/rossvincent/nanoclaw.git /tmp/nanoclaw-setup
bash /tmp/nanoclaw-setup/deploy/setup-vps.sh \
  --telegram-token "8625552162:AAGyXRQOTaDa3dOaCxZemPXoKo2mU6ZsXhw" \
  --anthropic-key "sk-ant-..." \
  --name "Kensho" \
  --instance "kensho" \
  --proxy-port 3002
```

Or with OAuth:
```bash
bash /tmp/nanoclaw-setup/deploy/setup-vps.sh \
  --telegram-token "8625552162:AAGyXRQOTaDa3dOaCxZemPXoKo2mU6ZsXhw" \
  --oauth-token "sk-ant-oat01-..." \
  --name "Kensho" \
  --instance "kensho" \
  --proxy-port 3002
```

## 3. Register your Telegram chat

After the script runs, Kensho will be live. Send a message to @My_kensho_bot on Telegram, then:

```bash
# Check logs for your chat ID:
journalctl -u nanoclaw-kensho --no-pager -n 20

# You'll see something like: tg:6442956907
# Register it:
cd /home/nanoclaw/kensho
sudo -u nanoclaw npx tsx setup/index.ts --step register \
  --jid "tg:6442956907" \
  --name "Ross" \
  --trigger "@Kensho" \
  --folder "main" \
  --channel "telegram" \
  --no-trigger-required \
  --is-main \
  --assistant-name "Kensho"

# Restart to pick up the registration:
systemctl restart nanoclaw-kensho
```

Or skip this step by passing `--chat-jid "tg:6442956907"` to the deploy script (since we already know your ID).

## 4. Adding Barky later

Same server, second instance:

```bash
bash /tmp/nanoclaw-setup/deploy/setup-vps.sh \
  --telegram-token "BARBYS_BOT_TOKEN" \
  --oauth-token "sk-ant-oat01-..." \
  --name "Barky" \
  --instance "barky" \
  --proxy-port 3001
```

This creates a separate install at `/home/nanoclaw/barky` with its own systemd service (`nanoclaw-barky`). Both share the Docker image and the `nanoclaw` user.

For Barky with WhatsApp instead of Telegram, you'll need to add the WhatsApp remote and auth – run `/setup` via Claude Code on the server.

## 5. Useful commands

```bash
# Status
systemctl status nanoclaw-kensho

# Live logs
journalctl -u nanoclaw-kensho -f

# Restart
systemctl restart nanoclaw-kensho

# Stop
systemctl stop nanoclaw-kensho

# Update code (pull + rebuild)
cd /home/nanoclaw/kensho
sudo -u nanoclaw git pull
sudo -u nanoclaw npm run build
systemctl restart nanoclaw-kensho

# Rebuild agent container (after Dockerfile changes)
cd /home/nanoclaw/kensho/container
docker build -t nanoclaw-agent:latest .
systemctl restart nanoclaw-kensho
```

## Cost

- Hetzner CX22: €4.50/mo (~£4)
- Claude API: variable (typically $5–15/mo for personal use)
- Telegram Bot API: free
- **Total: ~£10–20/mo for both Kensho and Barky on one box**
