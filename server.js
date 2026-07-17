/**
 * whatsapp-microservice/server.js — Padmavani School Dashboard
 *
 * Standalone WhatsApp sender service. Deploy this as its OWN Render web
 * service (separate from the main dashboard). It runs whatsapp-web.js
 * (Puppeteer/Chromium — the heavy part) so the main dashboard service no
 * longer needs to carry that CPU/RAM cost.
 *
 * The main dashboard talks to this service over plain HTTPS using a shared
 * API key (see .env.example). No Supabase / DB access happens here — this
 * service only knows how to send whatever text it's told to send.
 *
 * Endpoints:
 *   GET  /health            — public, no auth. Use as Render health check /
 *                              uptime ping to prevent free-tier spin-down.
 *   GET  /status             — auth required. { available, ready, initializing, queueLength, isProcessing, hasQr }
 *   GET  /qr                 — auth required. { qr: "data:image/png;base64,..." | null }
 *   POST /send                { to, text }                — auth required
 *   POST /send-bulk           { numbers: [...], text }     — auth required
 *   POST /logout              — auth required. Clears the saved session (force re-scan).
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

let Client, LocalAuth, QRCode;
try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    QRCode = require('qrcode');
} catch (e) {
    console.warn('[WhatsApp] whatsapp-web.js / qrcode not installed. Run `npm install`.');
}

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.WHATSAPP_API_KEY;

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
let client = null;
let isReady = false;
let isInitializing = false;
let lastQrDataUrl = null;
let messageQueue = [];
let isProcessing = false;
const SEND_DELAY_MS = 2000; // avoid WhatsApp rate limits / bans

function initWhatsApp() {
    if (!Client) return null;
    if (client || isInitializing) return client;
    isInitializing = true;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth' }),
        qrMaxRetries: 5,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--no-zygote',
                // NOTE: --single-process removed — it saves RAM but makes
                // Chromium noticeably less stable during the heavy first-time
                // chat sync right after scanning, which is exactly when we
                // saw phones show "device added" while the server-side
                // session silently died before 'ready'.
            ],
        },
        // WhatsApp's servers sometimes reject the linking handshake ("Couldn't
        // link device, try again") when Puppeteer's bundled Chromium reports
        // an old/mismatched User-Agent. Pinning a current desktop Chrome UA
        // here has fixed this for most whatsapp-web.js users hitting that error.
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });

    // ── Watchdog ──────────────────────────────────────────────────────────
    // On RAM-constrained hosts (e.g. Render free/starter tier), Chromium can
    // silently hang while launching (never fires 'qr', 'ready', 'auth_failure'
    // OR 'disconnected') — status gets stuck on "Connecting..." forever. If
    // none of those fire within WATCHDOG_MS, force-kill and retry from
    // scratch instead of hanging indefinitely.
    let hasAuthenticated = false;
    const WATCHDOG_MS = 90 * 1000;
    const watchdogClient = client;
    setTimeout(() => {
        if (client !== watchdogClient) return; // already progressed/replaced normally
        if (isReady || lastQrDataUrl || hasAuthenticated) return; // got somewhere — leave it alone
        console.warn('[WhatsApp] Client init stuck for', WATCHDOG_MS / 1000, 's with no progress — restarting.');
        isInitializing = false;
        client = null;
        watchdogClient.destroy().catch(() => {});
        initWhatsApp();
    }, WATCHDOG_MS);

    client.on('loading_screen', (percent, message) => {
        console.log(`[WhatsApp] Loading chats: ${percent}% — ${message}`);
    });

    client.on('ready', () => {
        isReady = true;
        isInitializing = false;
        lastQrDataUrl = null;
        console.log('[WhatsApp] Client is ready!');
        processQueue();
    });

    client.on('authenticated', () => {
        hasAuthenticated = true;
        console.log('[WhatsApp] Authenticated successfully — syncing chats, this can take a couple of minutes on first link.');
    });

    client.on('auth_failure', (msg) => {
        console.error('[WhatsApp] Authentication failed:', msg);
        // Previously this only flipped flags and left the dead client object
        // in place, so initWhatsApp()'s `if (client) return` meant nothing
        // ever retried — status got stuck showing a stale/invalid QR forever
        // even though the phone had already added the device. Recover the
        // same way 'disconnected' does: fully reset and retry.
        isReady = false;
        isInitializing = false;
        hasAuthenticated = false;
        lastQrDataUrl = null;
        const oldClient = client;
        client = null;
        setTimeout(() => {
            console.log('[WhatsApp] Retrying after auth failure...');
            oldClient.destroy().catch(() => {});
            initWhatsApp();
        }, 3000);
    });

    client.on('disconnected', (reason) => {
        console.warn('[WhatsApp] Client disconnected:', reason);
        isReady = false;
        isInitializing = false;
        hasAuthenticated = false;
        lastQrDataUrl = null;
        const oldClient = client;
        client = null;
        setTimeout(() => {
            console.log('[WhatsApp] Attempting to reconnect...');
            oldClient.destroy().catch(() => {});
            initWhatsApp();
        }, 5000);
    });

    client.on('qr', (qr) => {
        console.log('[WhatsApp] New QR code generated — scan it via GET /qr (with x-api-key header) or check the logs below.');
        QRCode.toString(qr, { type: 'terminal', small: true }, (err, qrTerm) => {
            if (!err) console.log(qrTerm);
        });
        QRCode.toDataURL(qr, (err, dataUrl) => {
            if (!err) lastQrDataUrl = dataUrl;
        });
    });

    client.initialize().catch(err => {
        console.error('[WhatsApp] Failed to initialize client:', err.message);
        isInitializing = false;
    });

    return client;
}

async function processQueue() {
    if (isProcessing || !isReady || messageQueue.length === 0) return;
    isProcessing = true;

    while (messageQueue.length > 0) {
        const { to, text } = messageQueue.shift();
        try {
            const chatId = to + '@c.us';
            await client.sendMessage(chatId, text);
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
        available: !!Client,
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
    if (!Client) return res.json({ queued: false, reason: 'whatsapp-web.js not installed' });
    if (!client) initWhatsApp();

    const clean = normalizeNumber(to);
    if (!clean || !text) return res.status(400).json({ queued: false, reason: 'invalid to/text' });

    messageQueue.push({ to: clean, text });
    if (isReady && !isProcessing) processQueue();
    res.json({ queued: true });
});

app.post('/send-bulk', requireApiKey, (req, res) => {
    const { numbers, text } = req.body || {};
    if (!Client) return res.json({ queued: 0, reason: 'whatsapp-web.js not installed' });
    if (!client) initWhatsApp();

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
        if (client) {
            await client.logout().catch(() => {});
            await client.destroy().catch(() => {});
        }
        client = null;
        isReady = false;
        isInitializing = false;
        lastQrDataUrl = null;
        setTimeout(initWhatsApp, 1000);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Boot ───────────────────────────────────────────────────────────────────
try {
    initWhatsApp();
} catch (err) {
    console.error('[WhatsApp] Could not start client on boot:', err.message);
}

app.listen(PORT, () => {
    console.log(`[WhatsApp Microservice] Listening on port ${PORT}`);
});
