# Speed-to-Lead: Deploy on DigitalOcean (start to finish)

Use this runbook on a **new Ubuntu droplet** (e.g. 1GB+ RAM). Replace placeholders like `YOUR_DOMAIN` and fill env secrets before going live.

---

## 1. Create the droplet

- **Image:** Ubuntu 24.04 LTS
- **Plan:** Basic, 1 GB RAM / 1 vCPU minimum (2 GB recommended for comfort)
- **Region:** Your choice
- **Authentication:** SSH key (recommended) or password
- Note the **droplet IP** (e.g. `104.236.88.26`)

---

## 2. SSH in and install Docker

```bash
ssh root@YOUR_DROPLET_IP
```

Then run:

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg lsb-release git

# Docker official repo
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker --version
docker compose version
```

---

## 3. Clone the app and create `.env`

```bash
cd /opt
git clone https://github.com/ThaMacroMan/Speed-to-Lead-Agent.git
cd /opt/Speed-to-Lead-Agent
cp .env.example .env
nano .env
```

Edit `.env` and set at least:

- `FORMSPREE_FORM_ID` — your Formspree form ID (e.g. `maqdrrkg`)
- `OPENAI_API_KEY` — your OpenAI API key
- `TWILIO_ACCOUNT_SID` — Twilio Account SID
- `TWILIO_AUTH_TOKEN` — Twilio Auth Token
- `TWILIO_PHONE_NUMBER` — your Twilio number (e.g. `+19256937466`)
- `DRY_RUN=false` — so SMS actually sends
- `BOOKING_LINK` — your Calendly (or other) link

Optional for testing:

- `QUIET_HOURS_START=0` and `QUIET_HOURS_END=0` — no quiet-hour blocking
- `ENABLE_VOICE=false` — SMS only

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

---

## 4. Start the app

```bash
cd /opt/Speed-to-Lead-Agent
docker compose up --build -d
docker compose ps -a
docker compose logs --tail 100 app
```

Check health:

```bash
curl -s http://localhost:3000/health
```

You should see: `{"status":"ok","service":"speed-to-lead",...}`

---

## 5. Public URL (pick one)

### Option A — Quick test: ngrok

**Install ngrok**

- **macOS (Homebrew):**
  ```bash
  brew install ngrok
  ```
- **Linux (droplet or local):** Download the binary and add to PATH, or use Snap:

  ```bash
  # Option 1: direct download (replace ARCH with amd64 or arm64)
  curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
  echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
  sudo apt update && sudo apt install -y ngrok

  # Option 2: snap (if available)
  sudo snap install ngrok
  ```

- Or get the binary from [ngrok.com/download](https://ngrok.com/download) and run `ngrok config add-authtoken YOUR_TOKEN` after signing up.

**Run the tunnel**

- If the app is running **on the droplet**: SSH in and run `ngrok http 3000` there (after installing ngrok on the droplet), or from your laptop run `ngrok http YOUR_DROPLET_IP:3000` (only works if port 3000 is open on the droplet).
- If the app is running **locally** (e.g. `npm run dev` or Docker on your Mac): run on your machine:
  ```bash
  ngrok http 3000
  ```

Use the HTTPS URL ngrok prints (e.g. `https://abc123.ngrok-free.app`) in step 6.  
Note: free ngrok URLs change each time you restart ngrok.

### Option B — Production: domain + Caddy (HTTPS)

On the **droplet**, with a domain pointed at the droplet IP (e.g. `agent.yourdomain.com` → droplet IP):

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

Create Caddyfile:

```bash
cat > /etc/caddy/Caddyfile <<'CADDY'
YOUR_DOMAIN {
    reverse_proxy localhost:3000
}
CADDY
```

Replace `YOUR_DOMAIN` with your real hostname (e.g. `agent.yourdomain.com`). Then:

```bash
systemctl reload caddy
curl -sI https://YOUR_DOMAIN/health
```

Your base URL is `https://YOUR_DOMAIN`.

---

## 6. Configure webhooks

Use your **public base URL** (ngrok or `https://YOUR_DOMAIN`).

### Twilio — Inbound SMS

1. Twilio Console → **Phone Numbers** → your number (or Messaging Service inbound config).
2. **Messaging** → **A message comes in**:
   - Webhook
   - URL: `https://YOUR_BASE_URL/webhooks/twilio/sms`
   - Method: **HTTP POST**
3. Save.

### Form trigger (form → agent)

- **Direct from site:** set env on the site (e.g. mybusiness):
  - `NEXT_PUBLIC_SPEED_TO_LEAD_WEBHOOK=https://YOUR_BASE_URL/webhooks/formspree`
- **Formspree:** in Formspree form settings, add webhook:
  - URL: `https://YOUR_BASE_URL/webhooks/formspree`
  - Method: POST

---

## 7. Verify end-to-end

1. **Health (public):**  
   `curl -s https://YOUR_BASE_URL/health`

2. **Form:** Submit contact form → you should get an SMS.

3. **Reply:** Reply to that SMS → agent should respond and conversation should continue.

4. **Lead memory (on droplet):**  
   `ls -la /opt/Speed-to-Lead-Agent/data/leads/`  
   Then e.g. `cat /opt/Speed-to-Lead-Agent/data/leads/<lead-id>/messages.ndjson` to see form + SMS messages.

---

## 8. Firewall (recommended for production)

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
ufw status
```

---

## Useful commands

| Task              | Command                          |
| ----------------- | -------------------------------- |
| Logs              | `docker compose logs -f app`     |
| Restart           | `docker compose restart app`     |
| Rebuild and start | `docker compose up --build -d`   |
| Stop              | `docker compose down`            |
| Data location     | `/opt/Speed-to-Lead-Agent/data/` |

---

## Endpoints reference

| Endpoint                      | Purpose                  |
| ----------------------------- | ------------------------ |
| `GET /health`                 | Health check             |
| `POST /webhooks/formspree`    | Form submissions → agent |
| `POST /webhooks/twilio/sms`   | Inbound SMS → agent      |
| `POST /webhooks/twilio/voice` | Voice callbacks          |
