# Padmavani WhatsApp Microservice

WhatsApp sending, split out of the main dashboard into its own service so the
heavy part (Puppeteer/Chromium via `whatsapp-web.js`) doesn't share CPU/RAM
with the dashboard on Render's free tier.

## 1. Push this folder as its own repo/service

This folder is meant to be deployed **separately** from
`PADMAVANI_SCHOOL_DASHBOARD-V3-main`. Two common ways:

- **Separate GitHub repo** (simplest): create a new repo, push just this
  `whatsapp-microservice/` folder's contents to it, connect that repo to a
  new Render Web Service.
- **Same repo, sub-folder**: if you'd rather keep one repo, push both
  folders together and in Render set **Root Directory** to
  `whatsapp-microservice` when creating the new service.

## 2. Create the Render Web Service

- New → Web Service → pick the repo
- Root Directory: `whatsapp-microservice` (if using the same-repo option)
- Build Command: `npm install`
- Start Command: `npm start`
- Instance type: Free is fine to start (see note on sleeping below)

## 3. Environment variables (Render dashboard → Environment)

- `WHATSAPP_API_KEY` — generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  ```
  Set the **same value** on the main dashboard service as
  `WHATSAPP_SERVICE_API_KEY`.

## 4. First-time login (QR scan)

After deploy, watch the Render logs — a QR code prints there. Scan it once
from your phone: WhatsApp → Linked Devices → Link a Device.

Easier option: call `GET /qr` (with header `x-api-key: <your key>`) from a
REST client or from the dashboard's admin panel (already wired up) and
render the returned `data:image/png;base64,...` as an `<img>`.

## ⚠️ Free tier has two separate limitations — know both

1. **Ephemeral disk.** Anything not on a Render Persistent Disk (which is a
   paid add-on) is wiped on every deploy/restart, including the
   `.wwebjs_auth/` session folder — meaning you'd need to re-scan the QR
   code after every redeploy of *this* service. Redeploying the *main*
   dashboard no longer affects this at all, which is the whole point of the
   split.
2. **Free services sleep after ~15 minutes of no traffic**, and a WhatsApp
   session that goes to sleep mid-connection can drop and need
   re-authentication more often than a paid always-on instance. If that
   becomes annoying, either upgrade this service to a paid instance, or
   ping `GET /health` every 10 minutes from a free uptime service (e.g.
   UptimeRobot / cron-job.org) to keep it awake — note this does not fix
   limitation #1, only #2.

## API reference

All routes except `/health` require header `x-api-key: <WHATSAPP_API_KEY>`.

| Method | Path         | Body                          | Notes |
|--------|--------------|--------------------------------|-------|
| GET    | /health      | —                              | public, use for uptime pings |
| GET    | /status      | —                              | `{ available, ready, initializing, queueLength, isProcessing, hasQr }` |
| GET    | /qr          | —                              | `{ qr: "data:image/png;base64,..." \| null }` |
| POST   | /send        | `{ to, text }`                 | `to` = 10-digit or full number, auto-prefixes `91` |
| POST   | /send-bulk   | `{ numbers: [...], text }`     | |
| POST   | /logout      | —                              | clears session, forces a fresh QR scan |

This service does **not** talk to Supabase or know about fees/marks/
announcements — it only queues and sends whatever text it's given. All of
that business logic (message templates, the enable/disable toggle, phone
lookups) stays in the main dashboard's `whatsapp-service.js`, which calls
this service over HTTPS.
