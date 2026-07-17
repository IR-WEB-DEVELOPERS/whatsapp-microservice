/**
 * whatsapp-microservice/server.js — Padmavani School Dashboard
 *
 * Standalone WhatsApp sender service. Deploy this as its OWN Render web
 * service (separate from the main dashboard). It runs Baileys — a direct
 * WebSocket client for WhatsApp Web with NO browser/Chromium involved — so
 * RAM usage stays low (roughly 50-100MB), comfortably inside Render's 512MB
 * free tier. (Previously this ran whatsapp-web.js/Puppeteer, which needed a
 * full headless Chromium and much more RAM — see server.js.wwebjs.bak for
 * that version.)
 *
 * The main dashboard talks to this service over plain HTTPS using a shared
 * API key (see .env.example). No Supabase / DB access happens here — this
 * service only knows how to send whatever text it's told to send.
 *
 * Endpoints (UNCHANGED — the dashboard side needs zero changes):
 *   GET  /health            — public, no auth. Use as Render health check /
 *                              uptime ping to prevent free-tier spin-down.
 *   GET  /status             — auth required. { available, ready, initializing, queueLength, isProcessing, hasQr, circuitBroken, ... }
 *   GET  /qr                 — auth required. { qr: "data:image/png;base64,..." | null }
 *   POST /send                { to, text }                — auth required
 *   POST /send-bulk           { numbers: [...], text }     — auth required
 *   POST /resume              — auth required. Clears a tripped circuit breaker (see below) and resumes the queue.
 *   POST /logout              — auth required. Clears the saved session (force re-scan).
 *
 * Anti-ban behaviour (tunable via env vars, see the "Anti-ban tuning" block
 * in this file):
 *   - 10-20s Gaussian-jittered gap between messages (bell-curve, not flat
 *     random — a uniform distribution is itself a detectable pattern)
 *   - randomized batch sizes of 10-15 with a 3-6 min pause between batches
 *   - default 9 AM-7 PM sending window
 *   - a 150/day hard ceiling, PERSISTED across restarts (see antiban-state.json
 *     in the auth folder) so a Render redeploy can't silently reset it
 *   - a warm-up ramp: a newly-linked (or re-linked) number starts at ~15/day
 *     and scales up to the full daily limit over WHATSAPP_WARMUP_DAYS (21 by
 *     default) — abrupt full-volume sending from a fresh link is itself a signal
 *   - a minimum 12h gap before messaging the same recipient again
 *   - typing-simulation before each send
 *   - a circuit breaker that halts sending the moment WhatsApp's responses
 *     start looking like a rate-limit/ban rather than retrying blind
 *   - read-receipt tracking that computes a real unread-message ratio and
 *     proactively pauses if it crosses a threshold — per current (2025-2026)
 *     industry research this is the single strongest ban-risk signal
 *     (unanswered proactive messages to people who don't reply), well above
 *     raw send speed, which is only one layer among several
 *
 * IMPORTANT — read this honestly: none of the above makes a ban impossible.
 * Baileys is an unofficial client that reverse-engineers the WhatsApp Web
 * protocol; using it on a regular number is against WhatsApp's Terms of
 * Service and WhatsApp can act on that at any time regardless of pacing.
 * The layers above reduce the *behavioural* signals WhatsApp's systems look
 * for (bot-like timing, stranger-messaging with no engagement, abrupt new-
 * number volume) but they do not, and cannot, eliminate ToS/ban risk. For a
 * school sending real, verifiable notifications to parents, the WhatsApp
 * Business (Cloud) API via an official Meta Business Solution Provider is
 * the only route with no ToS risk — worth it if this number getting banned
 * repeatedly is costing more (in re-setup time and missed notifications)
 * than the API's per-message cost would.
 */

require('dotenv').config();

const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// @whiskeysockets/baileys ships as a pure ESM package ("type": "module"),
// so it must be loaded with a dynamic import() rather than require() — a
// plain require() only happens to work on Node 22+, which can transparently
// require() ESM, but breaks on Node 20 (what Render's .node-version pins)
// with "require() of ES Module ... not supported". loadBaileysDeps() runs
// once before the server starts accepting traffic (see the boot section at
// the bottom of this file).
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Boom, pino, QRCode;

async function loadBaileysDeps() {
    try {
        const baileys = await import('@whiskeysockets/baileys');
        makeWASocket = baileys.default;
        ({ useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys);
        ({ Boom } = require('@hapi/boom'));
        pino = require('pino');
        QRCode = require('qrcode');
        logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' });
    } catch (e) {
        console.warn('[WhatsApp] @whiskeysockets/baileys / qrcode not installed. Run `npm install`.', e.message);
    }
}

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.WHATSAPP_API_KEY;
// NOTE: renamed from WWEBJS_AUTH_PATH. Baileys writes several small JSON
// files (creds + signal keys) into this folder rather than one profile dir.
const AUTH_PATH = process.env.WHATSAPP_AUTH_PATH || process.env.WWEBJS_AUTH_PATH || '.baileys_auth';

if (!API_KEY) {
    console.warn('[WhatsApp] WARNING: WHATSAPP_API_KEY is not set — every protected endpoint will reject requests. Set it in your environment.');
}

app.use(helmet());
app.use(cors()); // server-to-server calls only; tighten with { origin: [...] } if you also call this from a browser
app.use(express.json());

app.use(rateLimit({ windowMs: 60 * 1000, max: 60 })); // 60 req/min is plenty for a school's traffic

// ─── Auth middleware ────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.get('x-api-key');
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── WhatsApp client state ─────────────────────────────────────────────────
let sock = null;
let isReady = false;
let isInitializing = false;
let lastQrDataUrl = null;
let messageQueue = [];
let isProcessing = false;

// ─── Persistent anti-ban state ─────────────────────────────────────────────
// Previously dailyCount/dailyDateKey lived only in memory, which meant a
// Render restart (free tier spins down/redeploys often) silently reset the
// daily ceiling — the ONE hard limit that isn't just timing. It also had no
// idea how old the linked number's automation history was, or whether
// recipients were actually reading/replying, which are the signals that
// actually drive WhatsApp's ban decisions (far more than send pacing does).
// This file persists that state across restarts.
const STATE_FILE = process.env.WHATSAPP_STATE_FILE || require('path').join(AUTH_PATH, 'antiban-state.json');

function loadPersistedState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('[WhatsApp] Could not read antiban-state.json, starting fresh:', e.message);
    }
    return {};
}

function savePersistedState() {
    try {
        fs.mkdirSync(AUTH_PATH, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            dailyCount, dailyDateKey, firstLinkDate,
            recipientHistory, sentLog,
        }));
    } catch (e) {
        console.warn('[WhatsApp] Could not persist antiban-state.json:', e.message);
    }
}

const persisted = loadPersistedState();

// First-linked date — used to gate a "warm-up" ramp for numbers new to
// automation (see WARMUP logic below). If this isn't already known, it's
// set the first time the socket successfully connects (see 'open' handler).
let firstLinkDate = persisted.firstLinkDate || null;

// Per-recipient send history: { [jid]: lastSentAtMs } — enforces a minimum
// gap before messaging the same person again. Messaging the same stranger
// multiple times a day is one of the clearer "this isn't a human" signals,
// independent of overall pacing.
let recipientHistory = persisted.recipientHistory || {};
const MIN_RECIPIENT_GAP_MS = Number(process.env.WHATSAPP_MIN_RECIPIENT_GAP_MS) || 12 * 60 * 60 * 1000; // 12h

// Rolling log of recent sends with delivery/read status, used to compute a
// real reply/read ratio — this is the actual top-weighted ban signal
// (unanswered proactive messages to strangers), not send speed. Each entry:
// { jid, sentAt, status: 'sent'|'delivered'|'read'|'failed' }
let sentLog = persisted.sentLog || [];
const SENT_LOG_MAX = 500; // cap so the state file doesn't grow unbounded

function pruneSentLog() {
    if (sentLog.length > SENT_LOG_MAX) sentLog = sentLog.slice(sentLog.length - SENT_LOG_MAX);
}

function currentUnreadRatio() {
    // Only judge messages old enough to plausibly have been read (>2h),
    // otherwise every fresh batch looks artificially "unread".
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const judgable = sentLog.filter(e => e.sentAt < twoHoursAgo && e.status !== 'failed');
    if (judgable.length < 15) return null; // not enough data yet to mean anything
    const unread = judgable.filter(e => e.status !== 'read' && e.status !== 'replied').length;
    return unread / judgable.length;
}
// If this fraction of judgable messages are still un-read after the window,
// treat it as a live ban-risk signal, same tier as a circuit-breaker trip.
const UNREAD_RATIO_ALERT_THRESHOLD = Number(process.env.WHATSAPP_UNREAD_RATIO_THRESHOLD) || 0.85;

// ─── Anti-ban tuning ────────────────────────────────────────────────────────
// These exist because a script that sends messages at a perfectly fixed
// interval, back-to-back, with no daily ceiling, is exactly the pattern
// WhatsApp's anti-spam systems are built to catch. None of this is an
// official/guaranteed-safe recipe (Baileys is an unofficial client — there
// is no setting that makes a ban impossible), but it mimics human sending
// behaviour far more closely than a flat delay, which meaningfully lowers
// the chance of being flagged.
//
// Tuned deliberately conservative (slow) — wide per-message gap, smaller
// randomized batches, longer batch pauses, a quiet-hours window, and a
// circuit breaker that stops everything if WhatsApp starts throwing
// errors that look like a rate-limit/ban response. Slower + safer, by
// design, over fast + risky.
const MIN_DELAY_MS = Number(process.env.WHATSAPP_MIN_DELAY_MS) || 10000;  // lower bound per-message gap (10s)
const MAX_DELAY_MS = Number(process.env.WHATSAPP_MAX_DELAY_MS) || 20000;  // upper bound per-message gap (20s)
const BATCH_SIZE_MIN = Number(process.env.WHATSAPP_BATCH_SIZE_MIN) || 10; // randomized batch size lower bound
const BATCH_SIZE_MAX = Number(process.env.WHATSAPP_BATCH_SIZE_MAX) || 15; // randomized batch size upper bound
const BATCH_PAUSE_MIN_MS = Number(process.env.WHATSAPP_BATCH_PAUSE_MIN_MS) || 180000; // 3 min
const BATCH_PAUSE_MAX_MS = Number(process.env.WHATSAPP_BATCH_PAUSE_MAX_MS) || 360000; // 6 min
const DAILY_LIMIT = Number(process.env.WHATSAPP_DAILY_LIMIT) || 150;      // hard ceiling per calendar day
const SIMULATE_TYPING = process.env.WHATSAPP_SIMULATE_TYPING !== 'false'; // send "composing" presence before each msg

// Quiet hours — skip sending outside "human" hours (default 9 AM–7 PM
// server-local time). A bot that fires messages at 3 AM is one of the
// easiest patterns for WhatsApp to flag. Queue just waits; nothing is lost.
const QUIET_HOURS_ENABLED = process.env.WHATSAPP_QUIET_HOURS_ENABLED !== 'false';
const QUIET_HOURS_START = Number(process.env.WHATSAPP_QUIET_HOURS_START) || 9;  // 9 AM
const QUIET_HOURS_END = Number(process.env.WHATSAPP_QUIET_HOURS_END) || 19;     // 7 PM

function isWithinSendingWindow() {
    if (!QUIET_HOURS_ENABLED) return true;
    const hour = new Date().getHours();
    return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

function randomDelay(minMs, maxMs) {
    return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

// A flat uniform distribution between min/max is itself a subtle statistical
// tell — real human gaps cluster around a typical value with occasional
// longer tails, not an even spread. Box-Muller gives a bell-curve centered
// on the midpoint, clamped to [min, max].
function gaussianDelay(minMs, maxMs) {
    const mid = (minMs + maxMs) / 2;
    const spread = (maxMs - minMs) / 4; // ~95% of samples land inside [min,max]
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const val = mid + z * spread;
    return Math.max(minMs, Math.min(maxMs, Math.round(val)));
}

function randomBatchSize() {
    return BATCH_SIZE_MIN + Math.floor(Math.random() * (BATCH_SIZE_MAX - BATCH_SIZE_MIN + 1));
}

// ─── Circuit breaker ────────────────────────────────────────────────────────
// If WhatsApp starts rejecting sends the way it does when a number is
// rate-limited or heading toward a ban, hammering it with retries is the
// worst thing the service could do. Track consecutive failures; once a
// threshold is hit, stop sending entirely and require a manual /resume
// (or a service restart) rather than silently grinding through the queue.
const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.WHATSAPP_CIRCUIT_BREAKER_THRESHOLD) || 4;
const BAN_SIGNAL_PATTERNS = [/rate.?overlimit/i, /forbidden/i, /banned/i, /restricted/i, /not-authorized/i, /429/, /connection failure/i];
let consecutiveFailures = 0;
let circuitBroken = false;
let circuitBrokenReason = null;

function looksLikeBanSignal(message) {
    return BAN_SIGNAL_PATTERNS.some(re => re.test(String(message || '')));
}

// Daily counter — now persisted (see savePersistedState above) so a Render
// restart mid-day can't silently reset it and let the queue blow through
// the daily ceiling. This IS the one hard limit that matters most; the
// per-message/batch delays only smooth out how it's spent through the day.
let dailyCount = persisted.dailyCount || 0;
let dailyDateKey = persisted.dailyDateKey || new Date().toDateString();

// ── Warm-up ramp ────────────────────────────────────────────────────────
// A number that starts sending 150/day from the moment it's linked (or
// re-linked after a ban/logout) looks nothing like organic usage growth,
// which is itself a signal. Ramp the effective daily cap up over the first
// few weeks of this number's automation history instead of using DAILY_LIMIT
// at full strength immediately. Community "warming" practice: ramp slowly
// over 2-4 weeks — not an official Meta guarantee, just materially less
// abrupt than going full-volume on day one.
const WARMUP_DAYS = Number(process.env.WHATSAPP_WARMUP_DAYS) || 21;
const WARMUP_START_LIMIT = Number(process.env.WHATSAPP_WARMUP_START_LIMIT) || 15;

function effectiveDailyLimit() {
    if (!firstLinkDate) return WARMUP_START_LIMIT; // haven't even confirmed a stable link yet — stay minimal
    const daysSinceLink = (Date.now() - firstLinkDate) / (24 * 60 * 60 * 1000);
    if (daysSinceLink >= WARMUP_DAYS) return DAILY_LIMIT;
    const progress = daysSinceLink / WARMUP_DAYS;
    return Math.round(WARMUP_START_LIMIT + (DAILY_LIMIT - WARMUP_START_LIMIT) * progress);
}

// NOTE: dailyCount now only increments on an actual successful sendMessage()
// (see processQueue below), not speculatively before the send is attempted —
// so a failed/circuit-broken send no longer eats into the daily budget.

let logger; // created once pino has been loaded — see loadBaileysDeps()

async function initWhatsApp() {
    if (!makeWASocket) return null;
    if (sock || isInitializing) return sock;
    isInitializing = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        const { version } = await fetchLatestBaileysVersion();

        const newSock = makeWASocket({
            version,
            auth: state,
            logger,
            // We render our own QR (as a data URL via GET /qr), no need for
            // Baileys to also dump it to the terminal.
            printQRInTerminal: false,
            browser: ['Padmavani School Dashboard', 'Chrome', '126.0.0.0'],
        });
        sock = newSock;

        // ── Watchdog ──────────────────────────────────────────────────────
        // On RAM-constrained hosts (e.g. Render free/starter tier), the
        // socket can occasionally hang while the WebSocket handshake or
        // initial sync stalls — status gets stuck on "Connecting..."
        // forever. If neither a QR nor an open connection shows up within
        // WATCHDOG_MS, force-close and retry from scratch.
        const WATCHDOG_MS = 60 * 1000;
        const watchdogSock = newSock;
        setTimeout(() => {
            if (sock !== watchdogSock) return; // already progressed/replaced normally
            if (isReady || lastQrDataUrl) return; // got somewhere — leave it alone
            console.warn('[WhatsApp] Client init stuck for', WATCHDOG_MS / 1000, 's with no progress — restarting.');
            isInitializing = false;
            sock = null;
            try { watchdogSock.end(new Error('watchdog timeout')); } catch (_) {}
            initWhatsApp();
        }, WATCHDOG_MS);

        newSock.ev.on('creds.update', saveCreds);

        // Baileys reports delivery/read receipts here (status: 2=delivered,
        // 3=read/played, 4=played). We match them back to our sentLog by
        // message id to compute a real "are people actually reading these"
        // ratio — the strongest ban-risk signal per current research, well
        // above raw send speed.
        newSock.ev.on('messages.update', (updates) => {
            let changed = false;
            for (const u of updates) {
                const id = u.key?.id;
                const status = u.update?.status;
                if (!id || status == null) continue;
                const entry = sentLog.find(e => e.msgId === id);
                if (!entry) continue;
                if (status >= 3 && entry.status !== 'read') { entry.status = 'read'; changed = true; }
                else if (status === 2 && entry.status === 'sent') { entry.status = 'delivered'; changed = true; }
            }
            if (changed) savePersistedState();
        });

        // An actual incoming reply from a recipient is a stronger signal
        // than a read receipt — it's proof of two-way engagement, which is
        // exactly what "reply OK to confirm" style prompts are meant to
        // produce. Mark any sentLog entries for that jid as 'replied' (the
        // best status), which counts as engaged in currentUnreadRatio().
        newSock.ev.on('messages.upsert', ({ messages }) => {
            let changed = false;
            for (const m of messages || []) {
                if (m.key?.fromMe) continue; // only incoming
                const jid = m.key?.remoteJid;
                if (!jid) continue;
                for (const entry of sentLog) {
                    if (entry.jid === jid && entry.status !== 'replied') {
                        entry.status = 'replied';
                        changed = true;
                    }
                }
            }
            if (changed) savePersistedState();
        });

        newSock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WhatsApp] New QR code generated — scan it via GET /qr (with x-api-key header) or check the logs below.');
                QRCode.toString(qr, { type: 'terminal', small: true }, (err, qrTerm) => {
                    if (!err) console.log(qrTerm);
                });
                QRCode.toDataURL(qr, (err, dataUrl) => {
                    if (!err) lastQrDataUrl = dataUrl;
                });
            }

            if (connection === 'open') {
                isReady = true;
                isInitializing = false;
                lastQrDataUrl = null;
                if (!firstLinkDate) {
                    firstLinkDate = Date.now();
                    savePersistedState();
                    console.log('[WhatsApp] First link recorded — warm-up ramp starts now (full volume not reached for', WARMUP_DAYS, 'days).');
                }
                console.log('[WhatsApp] Client is ready!');
                processQueue();
            }

            if (connection === 'close') {
                isReady = false;
                isInitializing = false;
                lastQrDataUrl = null;

                const statusCode = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode
                    : lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;
                // A 401/"conflict" with reason "device_removed" (or similar
                // conflict codes) means WhatsApp itself force-removed this
                // linked session — this is different from a normal re-scan
                // logout, and often follows a spam/rate restriction on the
                // account (e.g. the 24h temporary block). Hammering it with
                // a fresh QR every few seconds is exactly the wrong move
                // here: it looks like more automated behaviour on an account
                // that's already under scrutiny. Back off hard instead.
                const conflictReason = update.lastDisconnect?.error?.output?.payload?.message
                    || JSON.stringify(lastDisconnect?.error?.data?.node?.content || '');
                const looksLikeForcedRemoval = /device_removed|conflict/i.test(String(lastDisconnect?.error?.message || '') + conflictReason)
                    || statusCode === 401;

                console.warn('[WhatsApp] Connection closed:', lastDisconnect?.error?.message || 'unknown reason', loggedOut ? '(logged out — will need a fresh QR scan)' : '(will attempt reconnect)');

                sock = null;

                if (loggedOut && looksLikeForcedRemoval) {
                    // Likely signal of an account-level restriction (e.g. the
                    // temporary block WhatsApp shows in the phone app after
                    // spam-pattern detection). Reset the warm-up ramp so the
                    // next successful link starts back at WARMUP_START_LIMIT
                    // instead of wherever it left off, force the circuit
                    // breaker open so nothing auto-sends on relink without a
                    // human explicitly calling /resume, and wait a long
                    // cooldown before even generating a new QR.
                    firstLinkDate = null;
                    circuitBroken = true;
                    circuitBrokenReason = 'Session was force-removed by WhatsApp (device_removed/conflict) — this usually follows an account restriction. Warm-up ramp has been reset. Confirm the linked phone\'s WhatsApp is not showing a ban/restriction notice before re-scanning, and call POST /resume only after that.';
                    savePersistedState();
                    const COOLDOWN_MS = Number(process.env.WHATSAPP_FORCED_LOGOUT_COOLDOWN_MS) || 30 * 60 * 1000; // 30 min
                    console.error(`[WhatsApp] Forced session removal detected — NOT auto-retrying. Waiting ${Math.round(COOLDOWN_MS / 60000)} min before even generating a new QR. Circuit breaker is open; check the account before POST /resume.`);
                    fs.rm(AUTH_PATH, { recursive: true, force: true }, () => {
                        setTimeout(() => {
                            console.log('[WhatsApp] Cooldown elapsed — generating a new QR (sending stays paused until /resume).');
                            initWhatsApp();
                        }, COOLDOWN_MS);
                    });
                } else if (loggedOut) {
                    // Session is no longer valid server-side (e.g. removed
                    // from Linked Devices on the phone). Wipe local creds so
                    // the next initWhatsApp() cleanly generates a new QR
                    // instead of retrying with dead credentials forever.
                    fs.rm(AUTH_PATH, { recursive: true, force: true }, () => {
                        setTimeout(() => {
                            console.log('[WhatsApp] Retrying after logout with a fresh session...');
                            initWhatsApp();
                        }, 3000);
                    });
                } else {
                    setTimeout(() => {
                        console.log('[WhatsApp] Attempting to reconnect...');
                        initWhatsApp();
                    }, 5000);
                }
            }
        });
    } catch (err) {
        console.error('[WhatsApp] Failed to initialize client:', err.message);
        isInitializing = false;
        sock = null;
    }

    return sock;
}

async function processQueue() {
    if (isProcessing || !isReady || messageQueue.length === 0) return;
    if (circuitBroken) {
        console.warn(`[WhatsApp] Circuit breaker is open (${circuitBrokenReason}) — not sending. Call POST /resume once you've confirmed the account is fine.`);
        return;
    }
    isProcessing = true;

    let sentInThisBatch = 0;
    let currentBatchTarget = randomBatchSize();

    while (messageQueue.length > 0) {
        if (circuitBroken) break;

        if (!isWithinSendingWindow()) {
            console.log(`[WhatsApp] Outside sending window (${QUIET_HOURS_START}:00–${QUIET_HOURS_END}:00) — pausing queue processing, will re-check in 15 min.`);
            break; // the setInterval nudge below will resume this once we're back in-window
        }

        const todayKey = new Date().toDateString();
        if (todayKey !== dailyDateKey) {
            dailyDateKey = todayKey;
            dailyCount = 0;
            savePersistedState();
        }

        const effLimit = effectiveDailyLimit();
        if (dailyCount >= effLimit) {
            const reason = effLimit < DAILY_LIMIT ? `warm-up ramp cap (${effLimit}/day, day ${Math.floor((Date.now() - firstLinkDate) / 86400000) + 1} of ${WARMUP_DAYS})` : `daily limit of ${DAILY_LIMIT}`;
            console.warn(`[WhatsApp] ${reason} reached — remaining ${messageQueue.length} message(s) stay queued until tomorrow.`);
            break;
        }

        // Real ban-risk signal check: if most recent judgable sends are
        // going unread, pause proactively rather than keep pushing more
        // messages into an account that's already showing the pattern
        // WhatsApp's models flag hardest (proactive messages to strangers
        // that never get engagement).
        const unreadRatio = currentUnreadRatio();
        if (unreadRatio !== null && unreadRatio >= UNREAD_RATIO_ALERT_THRESHOLD) {
            circuitBroken = true;
            circuitBrokenReason = `${Math.round(unreadRatio * 100)}% of recent messages are going unread — this is the strongest real ban-risk signal (unanswered-message tracking), independent of send speed. Pausing before WhatsApp's own systems flag the account. Check numbers/content before POST /resume.`;
            console.error(`[WhatsApp] CIRCUIT BREAKER TRIPPED — ${circuitBrokenReason}`);
            break;
        }

        const { to, text } = messageQueue[0];
        const jid = to + '@s.whatsapp.net';

        // Per-recipient minimum gap — don't message the same person twice
        // within MIN_RECIPIENT_GAP_MS. Requeue to the back rather than drop.
        const lastSentToThem = recipientHistory[jid];
        if (lastSentToThem && Date.now() - lastSentToThem < MIN_RECIPIENT_GAP_MS) {
            messageQueue.shift();
            messageQueue.push({ to, text });
            if (messageQueue.every(m => {
                const last = recipientHistory[m.to + '@s.whatsapp.net'];
                return last && Date.now() - last < MIN_RECIPIENT_GAP_MS;
            })) {
                console.log('[WhatsApp] Everyone left in queue was messaged too recently — pausing until gaps clear.');
                break;
            }
            continue;
        }
        messageQueue.shift();

        try {
            if (SIMULATE_TYPING) {
                // Briefly show "typing..." before sending — a bot that never
                // does this is an easy behavioural tell vs. a human sender.
                try {
                    await sock.sendPresenceUpdate('composing', jid);
                    await new Promise(resolve => setTimeout(resolve, 1000 + Math.floor(Math.random() * 2000)));
                    await sock.sendPresenceUpdate('paused', jid);
                } catch (_) { /* presence errors are non-fatal, just skip the flourish */ }
            }

            const result = await sock.sendMessage(jid, { text });
            dailyCount++;
            recipientHistory[jid] = Date.now();
            sentLog.push({ jid, msgId: result?.key?.id || null, sentAt: Date.now(), status: 'sent' });
            pruneSentLog();
            savePersistedState();
            console.log(`[WhatsApp] Sent to ${to} (${dailyCount}/${effLimit} today${effLimit < DAILY_LIMIT ? ', warm-up' : ''})`);
            consecutiveFailures = 0; // any clean send resets the breaker counter
        } catch (err) {
            console.error(`[WhatsApp] Failed to send to ${to}:`, err.message);
            consecutiveFailures++;

            if (looksLikeBanSignal(err.message) || consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                circuitBroken = true;
                circuitBrokenReason = looksLikeBanSignal(err.message)
                    ? `send error looked like a rate-limit/ban response: "${err.message}"`
                    : `${consecutiveFailures} consecutive send failures`;
                console.error(`[WhatsApp] CIRCUIT BREAKER TRIPPED — ${circuitBrokenReason}. Halting all sends. Remaining ${messageQueue.length + 1} message(s) stay queued. Investigate before calling POST /resume.`);
                break;
            }
        }

        sentInThisBatch++;

        if (messageQueue.length === 0) break;

        if (sentInThisBatch >= currentBatchTarget) {
            const pause = gaussianDelay(BATCH_PAUSE_MIN_MS, BATCH_PAUSE_MAX_MS);
            console.log(`[WhatsApp] Batch of ${sentInThisBatch} done — pausing ${Math.round(pause / 1000)}s before continuing (looks less bot-like than nonstop sending).`);
            await new Promise(resolve => setTimeout(resolve, pause));
            sentInThisBatch = 0;
            currentBatchTarget = randomBatchSize(); // re-randomize so batch size isn't a fixed, detectable pattern
        } else {
            await new Promise(resolve => setTimeout(resolve, gaussianDelay(MIN_DELAY_MS, MAX_DELAY_MS)));
        }
    }
    isProcessing = false;
}

function normalizeNumber(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return '91' + digits;
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    if (digits.length > 10) return digits;
    return null;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

app.get('/status', requireApiKey, (req, res) => {
    // reconcile the counter with "today" before reporting, in case no
    // send has happened yet since midnight
    const todayKey = new Date().toDateString();
    if (todayKey !== dailyDateKey) {
        dailyDateKey = todayKey;
        dailyCount = 0;
    }
    const unreadRatio = currentUnreadRatio();
    res.json({
        available: !!makeWASocket,
        ready: isReady,
        initializing: isInitializing,
        queueLength: messageQueue.length,
        isProcessing,
        hasQr: !!lastQrDataUrl,
        sentToday: dailyCount,
        dailyLimit: DAILY_LIMIT,
        effectiveDailyLimitToday: effectiveDailyLimit(),
        warmupActive: effectiveDailyLimit() < DAILY_LIMIT,
        firstLinkDate: firstLinkDate ? new Date(firstLinkDate).toISOString() : null,
        withinSendingWindow: isWithinSendingWindow(),
        quietHours: QUIET_HOURS_ENABLED ? `${QUIET_HOURS_START}:00–${QUIET_HOURS_END}:00` : 'disabled',
        unreadRatio: unreadRatio === null ? 'not enough data yet' : Math.round(unreadRatio * 100) + '%',
        circuitBroken,
        circuitBrokenReason,
    });
});

app.get('/qr', requireApiKey, (req, res) => {
    res.json({ qr: lastQrDataUrl || null });
});

app.post('/send', requireApiKey, (req, res) => {
    const { to, text } = req.body || {};
    if (!makeWASocket) return res.json({ queued: false, reason: '@whiskeysockets/baileys not installed' });
    if (!sock) initWhatsApp();

    const clean = normalizeNumber(to);
    if (!clean || !text) return res.status(400).json({ queued: false, reason: 'invalid to/text' });

    messageQueue.push({ to: clean, text });
    if (isReady && !isProcessing) processQueue();
    res.json({ queued: true });
});

app.post('/send-bulk', requireApiKey, (req, res) => {
    const { numbers, text } = req.body || {};
    if (!makeWASocket) return res.json({ queued: 0, reason: '@whiskeysockets/baileys not installed' });
    if (!sock) initWhatsApp();

    if (!Array.isArray(numbers) || numbers.length === 0 || !text) {
        return res.status(400).json({ queued: 0, reason: 'invalid numbers/text' });
    }

    let queued = 0;
    numbers.forEach(num => {
        const clean = normalizeNumber(num);
        if (clean) {
            messageQueue.push({ to: clean, text });
            queued++;
        }
    });
    if (isReady && !isProcessing) processQueue();
    res.json({ queued });
});

// Manual reset for the circuit breaker (see CIRCUIT_BREAKER_THRESHOLD above).
// Only call this after actually checking the linked phone / WhatsApp app —
// tripping this open is meant to force a human look before sending resumes.
app.post('/resume', requireApiKey, (req, res) => {
    const wasBroken = circuitBroken;
    circuitBroken = false;
    circuitBrokenReason = null;
    consecutiveFailures = 0;
    if (isReady && !isProcessing && messageQueue.length > 0) processQueue();
    res.json({ ok: true, wasBroken });
});

app.post('/logout', requireApiKey, async (req, res) => {
    try {
        if (sock) {
            await sock.logout().catch(() => {});
        }
        sock = null;
        isReady = false;
        isInitializing = false;
        lastQrDataUrl = null;
        fs.rm(AUTH_PATH, { recursive: true, force: true }, () => {
            setTimeout(initWhatsApp, 1000);
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// If the daily cap or quiet-hours window stops processQueue mid-queue,
// nothing else will nudge it again until a fresh /send call comes in. This
// just re-checks periodically so a backlog resumes on its own once the date
// rolls over or the sending window opens again, instead of silently sitting
// there until the next admin action. Does NOT auto-resume a tripped circuit
// breaker — that needs an explicit POST /resume after a human checks things.
setInterval(() => {
    if (!isProcessing && isReady && !circuitBroken && messageQueue.length > 0) {
        processQueue();
    }
}, 5 * 60 * 1000); // every 5 min

// ─── Boot ───────────────────────────────────────────────────────────────────
(async () => {
    await loadBaileysDeps();

    try {
        await initWhatsApp();
    } catch (err) {
        console.error('[WhatsApp] Could not start client on boot:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`[WhatsApp Microservice] Listening on port ${PORT}`);
    });
})();
