# Speed-to-Lead Agent (Node + Docker)

Code-first speed-to-lead backend with:

- Formspree webhook intake
- OpenClaw-style filesystem memory per lead
- AI qualification with conversation memory
- Multi-channel outreach (Twilio SMS, SendGrid email, Twilio voice drop)
- Automated follow-up jobs
- Docker + Redis runtime for VPS deployment

## Quick Start

1. Copy env template:
   - `cp .env.example .env`
2. Update required values in `.env`:
   - `FORMSPREE_FORM_ID` (ID or full Formspree URL both work)
   - `OPENAI_API_KEY` (model defaults to `gpt-5.2`)
   - Twilio and SendGrid credentials
3. Run locally:
   - `npm install`
   - `npm run dev`

## Docker Run

- Build and start:
  - `docker compose up --build -d`
- Check health:
  - `curl http://localhost:3000/health`
- Stop:
  - `docker compose down`

Persistent lead memory is mounted at `./data` on the host.

## Endpoints

- `POST /webhooks/formspree`
  - Ingests Formspree lead submissions
- `POST /webhooks/twilio/sms`
  - Handles inbound SMS replies
- `POST /webhooks/twilio/voice`
  - Handles Twilio voice callbacks
- `GET /health`
  - Container/app health check

## Lead Memory Layout

Each lead is saved in:

- `data/leads/<leadId>/lead.json`
- `data/leads/<leadId>/conversation.json`
- `data/leads/<leadId>/messages.ndjson`
- `data/leads/<leadId>/decisions.ndjson`
- `data/leads/<leadId>/followups.json`
- `data/leads/<leadId>/meta/status.json`

Indexes:

- `data/index/by-phone.json`
- `data/index/by-email.json`

Backups:

- `data/backups/*.json.gz`
# Speed-to-Lead-Agent
