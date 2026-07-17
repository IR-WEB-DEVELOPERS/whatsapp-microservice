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
 *   GET  /status             — auth required. { available, ready, initializing, queueLength, isProcessing, hasQr }
 *   GET  /qr                 — auth required. { qr: "data:image/png;base64,..." | null }
 *   POST /send                { to, text }                — auth required
 *   POST /send-bulk           { numbers: [...], text }     — auth required
 *   POST /logout              — auth required. Clears the saved session (force re-scan).
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
const SEND_DELAY_MS = 2000; // avoid WhatsApp rate limits / bans

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

                console.warn('[WhatsApp] Connection closed:', lastDisconnect?.error?.message || 'unknown reason', loggedOut ? '(logged out — will need a fresh QR scan)' : '(will attempt reconnect)');

                sock = null;

                if (loggedOut) {
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
    isProcessing = true;

    while (messageQueue.length > 0) {
        const { to, text } = messageQueue.shift();
        try {
            const jid = to + '@s.whatsapp.net';
            await sock.sendMessage(jid, { text });
            console.log(`[WhatsApp] Sent to ${to}`);
        } catch (err) {
            console.error(`[WhatsApp] Failed to send to ${to}:`, err.message);
        }
        if (messageQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
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
    res.json({
        available: !!makeWASocket,
        ready: isReady,
        initializing: isInitializing,
        queueLength: messageQueue.length,
        isProcessing,
        hasQr: !!lastQrDataUrl,
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
