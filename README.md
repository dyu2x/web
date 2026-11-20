# Mesina Farms Connect — Cloudflare Worker Edition

Version 2.0.0. This is a Cloudflare-native rebuild. It does **not** use Docker, Express, Socket.IO, or a VPS backend.

## Architecture

- **Cloudflare Worker:** API, login/authentication, Messenger and WhatsApp webhooks, outbound provider API calls.
- **Worker Static Assets:** agent dashboard and embeddable website chat widget, served by the same Worker deployment.
- **Neon PostgreSQL:** persistent contacts, channel identities, conversations, messages, agents, notes, and webhook history.
- **Polling:** the dashboard and web widget poll for updates every five seconds. This avoids Socket.IO, which is not supported as a conventional long-running server inside Workers. A future Durable Objects implementation can provide push-based real-time updates.

## Prerequisites

- Cloudflare account with Workers enabled.
- Node.js 20+ and npm on your deployment computer.
- Neon PostgreSQL project and connection string.
- Meta Developer app, Facebook Page and Messenger permissions for Messenger.
- WhatsApp Business Cloud API credentials for WhatsApp.

## 1. Create a Neon database

Create a dedicated Neon project/database for Connect. In Neon Console choose **Connect**, select the Node.js/Neon serverless option, and copy the pooled connection string when available. Keep `sslmode=require` in the connection URL.

Do not reuse the production CRM database/schema. The Worker creates its own tables (`agents`, `contacts`, `channel_identities`, `conversations`, `messages`, `webhook_events`, `conversation_notes`, and `crm_sync_log`) using idempotent `CREATE TABLE IF NOT EXISTS` statements.

## 2. Install and configure

```bash
unzip mesina-farms-connect-cloudflare-v2.0.zip
cd mesina-farms-connect
npm install
cp .dev.vars.example .dev.vars
```

For local development, fill in `.dev.vars`. Never commit `.dev.vars`.

Set a long random `APP_SECRET`, for example:

```bash
openssl rand -hex 32
```

Set `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD`. The first login bootstraps the initial admin agent if the `agents` table is empty. The password is stored as a PBKDF2-SHA256 hash.

## 3. Configure production Worker secrets

Use Wrangler secrets for sensitive values (do not put passwords or API tokens in `wrangler.jsonc`):

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put APP_SECRET
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ALLOWED_ORIGINS
```

`ALLOWED_ORIGINS` is a comma-separated list, e.g.:

```text
https://connect.mesina.farm,https://crm.mesina.farm,https://www.mesina.farm
```

Set provider secrets when ready:

```bash
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put MESSENGER_PAGE_ACCESS_TOKEN
npx wrangler secret put MESSENGER_PAGE_ID
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
```

`WHATSAPP_APP_SECRET` should be the Meta app secret used to validate `X-Hub-Signature-256` for WhatsApp webhook POST requests. The webhook rejects requests if this secret is missing.

Optional CRM settings (not enabled by default):

```bash
npx wrangler secret put CRM_BASE_URL
npx wrangler secret put CRM_API_TOKEN
npx wrangler secret put CRM_SYNC_ENABLED
```

Keep `CRM_SYNC_ENABLED=false` until the actual Mesina CRM API endpoints and authentication contract are confirmed and implemented. This build does not pretend to have a working CRM sync adapter.

## 4. Local test

```bash
npm run dev
```

Open the local Wrangler URL (normally `http://localhost:8787`). Check:

```bash
curl http://localhost:8787/health
```

The first API request initializes the schema in Neon. The first successful admin login creates the admin account. Do not expose local development with weak secrets.

## 5. Deploy

```bash
npm run deploy
```

Wrangler creates the Worker and deploys the `public/` directory as static assets. The API routes are executed by the Worker; the dashboard, CSS, JS, and widget are served as assets.

## 6. Connect your custom domain

In Cloudflare Dashboard:

1. Open **Workers & Pages** and select `mesina-farms-connect`.
2. Open **Settings → Domains & Routes**.
3. Add the custom domain `connect.mesina.farm` (the zone must be active in the same Cloudflare account).
4. Wait for Cloudflare to provision the route and TLS certificate.
5. Set `APP_BASE_URL` only if a later feature requires it; this build uses request origin for the dashboard and widget API base.

Alternatively use the generated `*.workers.dev` hostname while testing.

## 7. Website chat widget

Add this snippet to the website before the closing `</body>` tag:

```html
<script
  src="https://connect.mesina.farm/mesina-chat.js"
  data-endpoint="https://connect.mesina.farm"
  data-color="#176b45"
  defer>
</script>
```

The widget creates/continues a visitor conversation and polls for agent replies. Add the exact website origin to `ALLOWED_ORIGINS`.

## 8. Meta webhooks

Use these callback URLs in the Meta Developer dashboard:

- Messenger: `https://connect.mesina.farm/webhooks/messenger`
- WhatsApp: `https://connect.mesina.farm/webhooks/whatsapp`

Use the matching verify tokens configured as Worker secrets. Subscribe the Facebook Page to the required Messenger events and configure the WhatsApp webhook fields (including `messages`). Meta app review, Page permissions, business verification, and production access may be required.

The Worker validates Messenger and WhatsApp POST signatures using HMAC-SHA256 and the Meta app secret. Configure both secrets before activating the corresponding webhook. The WhatsApp webhook is intentionally rejected when its app secret is absent.

## 9. Important platform limitations and next steps

- **No Docker backend:** all application API and webhook handling runs in the Worker.
- **No Socket.IO:** dashboard and visitor chat use five-second polling. Durable Objects can be added later for lower-latency live updates.
- **CRM integration:** disabled pending confirmation of the real Mesina CRM API contract. The current Connect schema includes a `crm_customer_id` field and sync log table, but automatic customer/inquiry/order synchronization is not implemented in this Worker package.
- **WhatsApp policy:** free-form replies are subject to WhatsApp's customer-service window; approved templates are required for business-initiated messages outside that window.
- **Attachments:** the initial version stores text messages and media placeholders. Add R2-backed media upload/download before using attachments in production.
- **Agent administration:** initial administrator bootstrap is included; a full role/agent management interface is not included yet.
- **Rate limiting and abuse controls:** add Cloudflare WAF/rate limiting rules for public widget endpoints and login before broad public launch.
- **Neon connectivity:** this package uses `@neondatabase/serverless` HTTP queries, designed for serverless/Workers environments. Keep the Neon pooled connection string and TLS requirement.

## 10. Backup

Use Neon Console's backup/restore and branching features. You can also use PostgreSQL client tools from a trusted machine:

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl > mesina-connect-backup.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < mesina-connect-backup.sql
```

Protect backup files and test restores.

## 11. Health check

`GET /health` returns the runtime identity. For a real database check, log in or call an authenticated API endpoint; `/health` intentionally does not expose database credentials or internal error details.
