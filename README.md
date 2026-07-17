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

- Optional anti-ban tuning (all have sane defaults, only set these if you
  want to change the behaviour — see the "Avoiding a WhatsApp ban" section
  below for what they mean and why):
  - `WHATSAPP_MIN_DELAY_MS` (default `10000` — 10s)
  - `WHATSAPP_MAX_DELAY_MS` (default `20000` — 20s)
  - `WHATSAPP_BATCH_SIZE_MIN` (default `10`)
  - `WHATSAPP_BATCH_SIZE_MAX` (default `15`, randomized each batch)
  - `WHATSAPP_BATCH_PAUSE_MIN_MS` (default `180000` — 3 min)
  - `WHATSAPP_BATCH_PAUSE_MAX_MS` (default `360000` — 6 min)
  - `WHATSAPP_DAILY_LIMIT` (default `150`)
  - `WHATSAPP_SIMULATE_TYPING` (default `true`, set to `"false"` to disable)
  - `WHATSAPP_QUIET_HOURS_ENABLED` (default `true` — only sends 9 AM–7 PM server time)
  - `WHATSAPP_QUIET_HOURS_START` / `WHATSAPP_QUIET_HOURS_END` (defaults `9` / `19`)
  - `WHATSAPP_CIRCUIT_BREAKER_THRESHOLD` (default `4` consecutive failures before sending halts entirely)

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
| GET    | /status      | —                              | `{ available, ready, initializing, queueLength, isProcessing, hasQr, sentToday, dailyLimit, withinSendingWindow, quietHours, circuitBroken, circuitBrokenReason }` |
| GET    | /qr          | —                              | `{ qr: "data:image/png;base64,..." \| null }` |
| POST   | /send        | `{ to, text }`                 | `to` = 10-digit or full number, auto-prefixes `91` |
| POST   | /send-bulk   | `{ numbers: [...], text }`     | |
| POST   | /resume      | —                              | clears a tripped circuit breaker and resumes the queue — only call after checking the account is fine |
| POST   | /logout      | —                              | clears session, forces a fresh QR scan |

This service does **not** talk to Supabase or know about fees/marks/
announcements — it only queues and sends whatever text it's given. All of
that business logic (message templates, the enable/disable toggle, phone
lookups) stays in the main dashboard's `whatsapp-service.js`, which calls
this service over HTTPS.

## ⚠️ Avoiding a WhatsApp ban (read this before going live with bulk sends)

Baileys is an **unofficial** client — it logs in as a linked device on a
real personal/business WhatsApp number and talks to WhatsApp's servers the
same way WhatsApp Web does. There is **no setting that makes a ban
impossible**; anything below only reduces the odds by making the traffic
look less like a bot's. Treat this as risk-reduction, not a guarantee.

**What actually gets numbers banned, in rough order of importance:**

1. **A brand-new number blasting bulk messages immediately.** This is the
   single biggest cause. A number that has just been linked, with no
   normal call/chat history, sending 200 identical messages on day one is
   the clearest bot signature there is.
   → **Warm the number up first.** For the first 1–2 weeks, use it like a
   normal phone: send/receive a handful of individual chats a day, let a
   few contacts message it back, keep the profile photo + display name
   filled in like a real business. Only after that start bulk sending, and
   ramp the daily volume up gradually (e.g. 20–30/day → 50 → 100 → the
   `WHATSAPP_DAILY_LIMIT` ceiling), not straight to the ceiling.

2. **Recipients who don't already have your number saved.** If a parent
   hasn't saved the school's number as a contact, a message from an unknown
   number that they didn't message first is much more likely to be marked
   "spam" — and multiple spam reports against a number is the #2 cause of
   bans. Practically: publish the WhatsApp number on fee receipts, ID
   cards, the school website etc. and ask parents to save it, ideally
   *before* the first bulk message goes out.

3. **Identical text sent to a large number of people, fast.** The
   `sendFeeWhatsApp`/`sendMarksWhatsApp` templates already vary per parent
   (name, amount, marks), which is good. `sendAnnouncementWhatsApp` and
   `sendReportCardWhatsApp` send the *exact same string* to everyone —
   that's inherently more "broadcast-shaped." The delay/batch-pause/typing
   changes in this version help, but content variation (even just
   `Dear parent of {studentName},` as a prefix) helps more.

4. **Sending too fast / too mechanically.** Fixed intervals, fixed batch
   sizes, no breaks, no typing indicator — all addressed here: a randomized
   10-20s gap between every message (`WHATSAPP_MIN_DELAY_MS` /
   `WHATSAPP_MAX_DELAY_MS`), a randomized batch size of 10-15 messages
   before a 3-6 min pause (re-randomized each time, so the batch size isn't
   itself a fixed pattern), and `WHATSAPP_SIMULATE_TYPING`.

5. **No daily ceiling.** `WHATSAPP_DAILY_LIMIT` (default 150) caps how much
   goes out per calendar day regardless of how big the queue is; the rest
   waits till the next day. Push this up gradually as the number ages, not
   all at once.

6. **Sending outside normal hours.** By default the service only sends
   between 9 AM and 7 PM server time (`WHATSAPP_QUIET_HOURS_*`) — a queue
   that fires messages at 3 AM is an easy bot tell. Anything queued outside
   that window just waits; nothing is dropped.

7. **Not stopping when WhatsApp starts pushing back.** If sends start
   failing repeatedly, or the error looks like a rate-limit/ban response,
   keeping the queue running and just retrying is the fastest way to turn a
   warning into a permanent ban. The service now trips a circuit breaker
   after `WHATSAPP_CIRCUIT_BREAKER_THRESHOLD` (default 4) consecutive
   failures — or immediately on a response that looks ban-shaped — and
   stops sending entirely. Check `GET /status` for `circuitBroken` /
   `circuitBrokenReason`; check the linked WhatsApp account is actually
   fine (open the app on the phone, look for any warning) before calling
   `POST /resume`.

8. **Links/media that look promotional**, or messages containing only a
   link with no personal context, tend to get reported more. The current
   templates are plain informational text, which is the safer shape — keep
   it that way rather than adding banners/links if you can avoid it.

**If you need this to be bulletproof, not just lower-risk:** the only way
to get an actual guarantee against being blocked for legitimate
transactional/utility messages (fee receipts, marks, announcements) is
Meta's **official WhatsApp Business Platform (Cloud API)**. It costs a
small per-conversation fee, requires pre-approved message templates, and
needs a bit more setup (Meta Business verification), but it is sanctioned
by WhatsApp itself — no anti-spam heuristics to trip. Worth considering
once volume grows past what feels safe to run through an unofficial
client like this one. For now, the tuning above is the practical middle
ground for a school-sized deployment.
