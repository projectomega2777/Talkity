const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!(process.env.VERCEL || process.env.NOW_REGION || process.env.LAMBDA_TASK_ROOT);

// Safe startup diagnostics: log only presence of required provider keys
// (never their values, lengths, prefixes, or derived details)
function logSafeEnvPresence(label, exists) {
  console.log(`[EnvCheck] ${label} present: ${exists}`);
}
logSafeEnvPresence('GROQ_API_KEY', !!process.env.GROQ_API_KEY);
logSafeEnvPresence('OPENAI_API_KEY', !!process.env.OPENAI_API_KEY);

// ==========================================
// 🛡️ SECURITY MEASURES: Headers & Hardening
// ==========================================

// 1. Hide server software disclosure
app.disable('x-powered-by');

// 2. Strict HTTP Security Headers Middleware
app.use((req, res, next) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking / frame embedding
  res.setHeader('X-Frame-Options', 'DENY');
  // XSS protection for legacy browsers
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Control referrer information leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict sensitive browser features (Microphone permitted only on self domain)
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  // Strict Transport Security (HSTS)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // Content Security Policy (CSP)
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self' https://api.groq.com https://api.openai.com wss: ws:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
});

// 3. Strict CORS Configuration (B3: explicit allowlist — no wildcards)
// Production origins are always allowed. Local-development origins are only
// allowed when the server is NOT running in production mode.
const PRODUCTION_ORIGINS = [
  'https://talkity-qifh.onrender.com',
  'https://talkity.vercel.app'
];
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || IS_VERCEL;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (PRODUCTION_ORIGINS.includes(origin)) return callback(null, true);
    if (!IS_PRODUCTION && DEV_ORIGINS.includes(origin)) return callback(null, true);
    // Disallowed origins get no Access-Control-Allow-Origin header. CORS is
    // defence-in-depth only; authentication below is the real gatekeeper.
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-talkity-token', 'x-language'],
  credentials: false
}));

// 3b. Authentication (B1/B2): single shared deployment token, server-side only.
// - REST: "Authorization: Bearer <token>" or "x-talkity-token: <token>"
// - WS:   {"type":"auth","token":<t>} as the first frame, a "token" field inside
//         the first register frame, or a "?token=" query parameter.
// The token is configured via TALKITY_API_TOKEN and is NEVER embedded in
// client-side JavaScript; users enter it in their client settings.
// Development bypass: when no token is configured AND the request originates
// from a loopback address AND the server is not in production mode.
const API_TOKEN = (process.env.TALKITY_API_TOKEN || '').trim();
logSafeEnvPresence('TALKITY_API_TOKEN', !!API_TOKEN);

function timingSafeTokenMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  if (supplied.length === 0 || supplied.length > 256) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractRequestToken(req) {
  const authz = req.headers['authorization'];
  if (typeof authz === 'string') {
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  const t = req.headers['x-talkity-token'];
  if (typeof t === 'string') return t.trim();
  return '';
}

function isLoopbackAddress(address) {
  const ip = typeof address === 'string' ? address : '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireAuth(req, res, next) {
  if (API_TOKEN) {
    const supplied = extractRequestToken(req);
    if (supplied && timingSafeTokenMatch(supplied, API_TOKEN)) return next();
    return res.status(401).json({ error: 'Unauthorized. A valid Talkity API token is required.' });
  }
  if (!IS_PRODUCTION && isLoopbackAddress(req.socket && req.socket.remoteAddress)) return next();
  if (IS_PRODUCTION) {
    return res.status(503).json({ error: 'Server authentication is not configured (TALKITY_API_TOKEN missing).' });
  }
  return res.status(401).json({ error: 'Unauthorized. A valid Talkity API token is required.' });
}

// WebSocket token check. With a configured token, only exact (timing-safe)
// matches authenticate. Without a token, no WebSocket connection can
// authenticate via a frame; local development grants a loopback bypass at
// connect time instead (see the connection handler).
function verifyWsToken(token) {
  if (API_TOKEN) return timingSafeTokenMatch(typeof token === 'string' ? token : '', API_TOKEN);
  return false;
}

// 🛡️ SECURITY (B4): coerce client-supplied clientId values into a safe,
// bounded representation — printable ASCII only, trimmed, max 64 characters.
// Handles missing, non-string, and oversized/multi-line values safely and is
// used consistently for logging, stored registration state, and broadcast
// payloads. Legitimate clients (short ASCII ids) are unaffected.
function sanitizeClientId(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const safe = value.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 64);
  return safe || fallback;
}

// 4. In-Memory IP Rate Limiter (Protects against DDoS, brute force & API abuse)
const rateLimitMap = new Map();

function rateLimiter(maxRequests = 100, windowMs = 60 * 1000) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };

    if (now > entry.resetTime) {
      entry.count = 1;
      entry.resetTime = now + windowMs;
    } else {
      entry.count += 1;
    }

    rateLimitMap.set(ip, entry);

    // Clean up expired entries periodically
    if (rateLimitMap.size > 5000) {
      for (const [key, val] of rateLimitMap.entries()) {
        if (now > val.resetTime) rateLimitMap.delete(key);
      }
    }

    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((entry.resetTime - now) / 1000));
      return res.status(429).json({
        error: 'Too many requests. Please slow down.',
        retryAfterSeconds: Math.ceil((entry.resetTime - now) / 1000)
      });
    }

    next();
  };
}

// Global general rate limit: 120 req/min
app.use(rateLimiter(120, 60 * 1000));

// Specific strict rate limit for AI operations: 35 req/min
const aiRateLimiter = rateLimiter(35, 60 * 1000);

// 5. Body Parsing with Safe Limits
// Audio upload limited to 10MB max (sufficient for several minutes of speech)
app.use('/api/transcribe', express.raw({ type: '*/*', limit: '10mb' }));
app.use('/transcribe', express.raw({ type: '*/*', limit: '10mb' }));

// JSON payload limited to 100KB (prevents memory exhaustion)
app.use(express.json({ limit: '100kb' }));

// Static file serving
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath, { dotfiles: 'ignore', index: 'index.html' }));
}

// ==========================================
// 📦 Safe Data Storage (Local & Serverless)
// ==========================================
const DATA_DIR = IS_VERCEL ? path.join('/tmp', 'talkity-data') : path.join(__dirname, 'data');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {}

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const DICTIONARY_FILE = path.join(DATA_DIR, 'dictionary.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// In-Memory Storage Fallbacks
let inMemoryHistory = [];
let inMemoryDictionary = [
  { phrase: "talkity", replacement: "Talkity" },
  { phrase: "antigravity", replacement: "Antigravity" },
  { phrase: "piyush", replacement: "Piyush" },
  { phrase: "ui automation", replacement: "UI Automation" }
];
let inMemorySettings = {
  language: 'en-IN',
  autoCopy: true,
  soundChimes: true
};

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return fallback;
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {}
}

if (!fs.existsSync(HISTORY_FILE)) writeJSON(HISTORY_FILE, []);
if (!fs.existsSync(DICTIONARY_FILE)) writeJSON(DICTIONARY_FILE, inMemoryDictionary);

// 🛡️ SECURITY (B2): scrub legacy client-supplied provider keys that older
// versions may have persisted to settings.json. Only the legacy secret fields
// are removed; every other saved setting is preserved untouched. The key
// values are never logged, never served, and never reused. New settings.json
// files written by this version never contain these fields.
function scrubLegacySettingsKeys() {
  try {
    const disk = readJSON(SETTINGS_FILE, null);
    if (disk && typeof disk === 'object' && !Array.isArray(disk) &&
        (disk.groqApiKey !== undefined || disk.openaiApiKey !== undefined)) {
      const clean = { ...disk };
      delete clean.groqApiKey;
      delete clean.openaiApiKey;
      writeJSON(SETTINGS_FILE, clean);
    }
  } catch (e) {}
}
scrubLegacySettingsKeys();

function getRawSettings() {
  const disk = readJSON(SETTINGS_FILE, null);
  if (disk) return disk;
  return inMemorySettings;
}

// 🛡️ SECURITY (B2): Never expose plaintext API keys to clients via GET /settings.
// Provider credentials are held server-side (environment variables) only.
function getClientSafeSettings() {
  const s = getRawSettings();
  return {
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    hasOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
    language: typeof s.language === 'string' ? s.language.slice(0, 10) : 'en-IN',
    autoCopy: Boolean(s.autoCopy ?? true),
    soundChimes: Boolean(s.soundChimes ?? true)
  };
}

function saveSettings(settings) {
  // Input validation
  const sanitized = {
    language: typeof settings.language === 'string' ? settings.language.slice(0, 10) : 'en-IN',
    autoCopy: Boolean(settings.autoCopy ?? true),
    soundChimes: Boolean(settings.soundChimes ?? true)
  };
  // 🛡️ SECURITY (B2): client-supplied provider API keys are never accepted,
  // never persisted, and never override server-held credentials. Legacy
  // fields sent by older clients are intentionally ignored here.
  inMemorySettings = { ...inMemorySettings, ...sanitized };
  writeJSON(SETTINGS_FILE, inMemorySettings);
}

// WebSocket setup (Local standalone only)
const clients = new Map(); // Map<WebSocket, clientMetadata>
let desktopClient = null;

// Heartbeat monitoring configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 35000; // 35 seconds (give 5s grace period)
const WS_AUTH_WINDOW_MS = 6000; // unauthenticated WS connections must authenticate within this window

if (!IS_VERCEL) {
  try {
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

    wss.on('connection', (ws, req) => {
      const clientMeta = {
        id: `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: Date.now(),
        isDesktop: false,
        isExtension: false,
        isAlive: true,
        authenticated: false
      };

      clients.set(ws, clientMeta);
      console.log(`[WebSocket] Client connected: ${clientMeta.id}`);

      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Talkity WebSocket connected',
        clientId: clientMeta.id,
        serverTime: new Date().toISOString()
      }));

      // 🛡️ SECURITY (B1): authenticate the connection.
      // Sources, in order: loopback dev bypass (no token configured, local
      // only), "?token=" query parameter (desktop-client compatibility), or
      // an auth/register frame carrying the token.
      let authDeadlineTimer = null;
      if (!API_TOKEN) {
        const loopback = req && req.socket ? isLoopbackAddress(req.socket.remoteAddress) : false;
        if (loopback && !IS_PRODUCTION) clientMeta.authenticated = true;
      } else {
        try {
          const reqUrl = new URL(req.url, 'http://talkity.local');
          if (timingSafeTokenMatch(reqUrl.searchParams.get('token') || '', API_TOKEN)) {
            clientMeta.authenticated = true;
          }
        } catch (e) {}
      }
      if (!clientMeta.authenticated) {
        authDeadlineTimer = setTimeout(() => {
          if (!clientMeta.authenticated) {
            console.log(`[WebSocket] Closing unauthenticated connection: ${clientMeta.id}`);
            try { ws.close(4001, 'unauthorized'); } catch (e) {}
          }
        }, WS_AUTH_WINDOW_MS);
        if (typeof authDeadlineTimer.unref === 'function') authDeadlineTimer.unref();
      }

      // Heartbeat ping
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
        if (clients.has(ws)) {
          clients.get(ws).lastHeartbeat = Date.now();
        }
      });

      ws.on('message', (msg) => {
        try {
          if (typeof msg !== 'string' && !Buffer.isBuffer(msg)) return;
          const data = JSON.parse(msg.toString());

          // 🛡️ SECURITY (B4): validate message shape before any processing.
          if (!data || typeof data !== 'object' || Array.isArray(data) ||
              typeof data.type !== 'string' || data.type.length === 0 || data.type.length > 32) {
            try { ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' })); } catch (e) {}
            return;
          }

          // 🛡️ SECURITY (B1): everything except keep-alives and the auth frame
          // requires an authenticated connection. Invalid or missing tokens
          // terminate the connection.
          if (!clientMeta.authenticated) {
            if (data.type === 'heartbeat') {
              clientMeta.lastHeartbeat = Date.now();
              ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
              return;
            }
            const candidateToken = typeof data.token === 'string' ? data.token : '';
            if (data.type === 'auth' || data.type === 'register_desktop' || data.type === 'register_extension') {
              if (verifyWsToken(candidateToken)) {
                clientMeta.authenticated = true;
                if (authDeadlineTimer) { clearTimeout(authDeadlineTimer); authDeadlineTimer = null; }
                try { ws.send(JSON.stringify({ type: 'authenticated', ok: true })); } catch (e) {}
                // Fall through so a register_* frame is handled below as well.
              } else {
                console.log(`[WebSocket] Rejected unauthorized frame from ${clientMeta.id}`);
                try { ws.close(4001, 'unauthorized'); } catch (e) {}
                return;
              }
            } else {
              try { ws.close(4001, 'unauthorized'); } catch (e) {}
              return;
            }
          }

          // Handle client heartbeat
          if (data.type === 'heartbeat') {
            if (clients.has(ws)) {
              clients.get(ws).lastHeartbeat = Date.now();
            }
            ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
            return;
          }

          // Handle heartbeat acknowledgment
          if (data.type === 'heartbeat_ack') {
            if (clients.has(ws)) {
              clients.get(ws).lastHeartbeat = Date.now();
              clients.get(ws).isAlive = true;
            }
            return;
          }

          // Desktop client registration (clientId sanitized at the boundary)
          if (data.type === 'register_desktop') {
            const safeClientId = sanitizeClientId(data.clientId, clientMeta.id);
            desktopClient = ws;
            if (clients.has(ws)) {
              clients.get(ws).isDesktop = true;
              clients.get(ws).clientId = safeClientId;
            }
            console.log(`[WebSocket] Desktop client registered: ${safeClientId}`);
            broadcast({ type: 'desktop_status', connected: true, clientId: safeClientId });
            return;
          }

          // Extension client registration (clientId sanitized at the boundary)
          if (data.type === 'register_extension') {
            const safeClientId = sanitizeClientId(data.clientId, clientMeta.id);
            if (clients.has(ws)) {
              clients.get(ws).isExtension = true;
              clients.get(ws).clientId = safeClientId;
            }
            console.log(`[WebSocket] Extension client registered: ${safeClientId}`);
            ws.send(JSON.stringify({ type: 'extension_registered', success: true }));
            return;
          }

          // 🛡️ SECURITY (B4): only allow-listed message types are relayed to
          // other authenticated clients. Unknown types are rejected instead of
          // being blindly re-broadcast. inject_text is server-generated only:
          // clients can never inject into other clients via the WebSocket.
          if (data.type === 'transcription') {
            const text = typeof data.text === 'string' ? data.text.slice(0, 5000) : '';
            if (!text) {
              try { ws.send(JSON.stringify({ type: 'error', message: 'Invalid transcription payload' })); } catch (e) {}
              return;
            }
            const relay = { type: 'transcription', text, tone: typeof data.tone === 'string' ? data.tone.slice(0, 32) : 'clean', timestamp: Date.now() };
            for (const [client, meta] of clients.entries()) {
              if (client !== ws && client.readyState === 1 && meta.authenticated) {
                client.send(JSON.stringify(relay));
              }
            }
            return;
          }

          try { ws.send(JSON.stringify({ type: 'error', message: 'Unsupported message type' })); } catch (e) {}
        } catch (e) {
          console.error('[WebSocket] Message error:', e.message);
        }
      });

      ws.on('close', () => {
        if (authDeadlineTimer) clearTimeout(authDeadlineTimer);
        const meta = clients.get(ws);
        clients.delete(ws);

        if (meta) {
          console.log(`[WebSocket] Client disconnected: ${meta.id} (was desktop: ${meta.isDesktop})`);
        }

        if (desktopClient === ws) {
          desktopClient = null;
          broadcast({ type: 'desktop_status', connected: false });
          console.log('[WebSocket] Desktop client disconnected');
        }
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Client error:', error.message);
      });
    });

    // Heartbeat monitoring: ping all clients periodically
    const heartbeatInterval = setInterval(() => {
      for (const [ws, meta] of clients.entries()) {
        if (ws.isAlive === false) {
          console.log(`[WebSocket] Terminating dead connection: ${meta.id}`);
          clients.delete(ws);
          if (desktopClient === ws) {
            desktopClient = null;
            broadcast({ type: 'desktop_status', connected: false });
          }
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();

        // Also send JSON heartbeat for compatibility with custom clients
        try {
          ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
        } catch (e) {}
      }
    }, HEARTBEAT_INTERVAL);

    // Do not keep the process alive solely for the heartbeat timer. The HTTP
    // server and WebSocket clients still keep it alive while they are active.
    if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();

    wss.on('close', () => {
      clearInterval(heartbeatInterval);
    });

    console.log('[WebSocket] Server initialized with heartbeat monitoring');
  } catch (e) {
    console.error('[WebSocket] Initialization error:', e.message);
  }
}

function broadcast(event) {
  const payload = JSON.stringify(event);
  let sent = 0;
  for (const [client, meta] of clients.entries()) {
    // 🛡️ SECURITY (B4): events are only delivered to authenticated clients.
    if (client.readyState === 1 && meta.authenticated) {
      try {
        client.send(payload);
        sent++;
      } catch (e) {
        console.error(`[WebSocket] Broadcast error to ${meta.id}:`, e.message);
      }
    }
  }
  if (sent > 0) {
    console.log(`[WebSocket] Broadcast to ${sent} client(s): ${event.type}`);
  }
}

function getWebSocketStats() {
  const stats = {
    totalClients: clients.size,
    desktopConnected: desktopClient !== null,
    clients: []
  };

  for (const [ws, meta] of clients.entries()) {
    stats.clients.push({
      id: meta.id,
      isDesktop: meta.isDesktop,
      connectedAt: meta.connectedAt,
      lastHeartbeat: new Date(meta.lastHeartbeat).toISOString(),
      isAlive: ws.isAlive !== false
    });
  }

  return stats;
}

// ==========================================
// Whisper transcript normalization & diagnostics
// ==========================================

// Whisper accepts ISO-639-1 language codes, not region-qualified locales.
// Sending nothing lets the model auto-detect, which is required for Hinglish.
const WHISPER_LANGUAGES = new Set([
  'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca',
  'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr',
  'gl', 'gu', 'ha', 'haw', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja',
  'jw', 'ka', 'kk', 'km', 'kn', 'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg',
  'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc',
  'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd', 'si', 'sk', 'sl', 'sn', 'so',
  'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt',
  'uk', 'ur', 'uz', 'vi', 'yi', 'yo', 'zh'
]);

function normalizeWhisperLanguage(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;
  return WHISPER_LANGUAGES.has(code) ? code : null;
}

// Conservative transcript cleanup used for Whisper output. Unlike the
// "clean" tone in ruleBasedPolish, this never removes filler words or
// reorders text: it only applies dictionary spellings, whitespace,
// punctuation spacing, and capitalization. The word sequence is preserved.
function formatTranscriptText(text, dictionary = []) {
  if (!text || typeof text !== 'string') return '';
  let result = text.replace(/\r\n?/g, '\n').slice(0, 10000);

  if (Array.isArray(dictionary)) {
    for (const item of dictionary.slice(0, 50)) {
      if (item && typeof item.phrase === 'string' && typeof item.replacement === 'string') {
        const safePhrase = item.phrase.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const safeReplacement = item.replacement.slice(0, 100);
        try {
          result = result.replace(new RegExp(`\\b${safePhrase}\\b`, 'gi'), safeReplacement);
        } catch (e) {}
      }
    }
  }

  result = result
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!result) return '';

  result = result.replace(/[ \t]+([,.!?;:])/g, '$1');
  result = result.replace(/([,;:])([A-Za-z])/g, '$1 $2');
  result = result.replace(/(^|\n)([^\p{L}\p{N}\n]*)([a-z])/gu, (m, lead, prefix, ch) => lead + prefix + ch.toUpperCase());
  result = result.replace(/(^|[^A-Za-z])i(?![A-Za-z]|\.[A-Za-z])/g, (m, lead) => lead + 'I');
  if (/[A-Za-z0-9]$/.test(result)) result += '.';
  return result;
}

// Build a short vocabulary hint for Whisper from the user's dictionary.
// Groq documents the prompt parameter for "how to spell unfamiliar words";
// the cap keeps it far below the 224-token limit.
function buildVocabularyPrompt(dictionary, maxChars = 800) {
  if (!Array.isArray(dictionary)) return '';
  const seen = new Set();
  const terms = [];
  for (const item of dictionary.slice(0, 50)) {
    if (!item || typeof item.replacement !== 'string') continue;
    const term = item.replacement
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 20) break;
  }
  if (!terms.length) return '';
  let prompt = 'Vocabulary: ' + terms.join(', ') + '.';
  if (prompt.length > maxChars) prompt = prompt.slice(0, maxChars - 1).trim() + '.';
  return prompt;
}

// Duration from a RIFF/WAVE header. Used only to skip vocabulary prompting on
// very short or silent clips, where a prompt is most likely to leak into output.
function wavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(body + 8);
    } else if (id === 'data') {
      dataSize = Math.max(0, Math.min(size, buffer.length - body));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return dataSize / byteRate;
}

// Log quality metadata only. Never log the transcript or the audio.
function logWhisperMetadata(provider, data, audioSeconds, promptUsed) {
  try {
    const segments = Array.isArray(data.segments) ? data.segments : [];
    let minLogprob = null;
    let maxNoSpeech = null;
    let maxCompression = null;
    for (const segment of segments) {
      if (!segment) continue;
      if (typeof segment.avg_logprob === 'number')
        minLogprob = minLogprob === null ? segment.avg_logprob : Math.min(minLogprob, segment.avg_logprob);
      if (typeof segment.no_speech_prob === 'number')
        maxNoSpeech = maxNoSpeech === null ? segment.no_speech_prob : Math.max(maxNoSpeech, segment.no_speech_prob);
      if (typeof segment.compression_ratio === 'number')
        maxCompression = maxCompression === null ? segment.compression_ratio : Math.max(maxCompression, segment.compression_ratio);
    }
    const fmt = (value) => value === null ? 'n/a' : Number(value).toFixed(3);
    console.log(
      `[Whisper] provider=${provider} lang=${data.language || 'auto'} ` +
      `audio=${Number(audioSeconds || 0).toFixed(2)}s segments=${segments.length} ` +
      `minLogprob=${fmt(minLogprob)} maxNoSpeech=${fmt(maxNoSpeech)} ` +
      `maxCompression=${fmt(maxCompression)} prompt=${promptUsed ? 'yes' : 'no'}`
    );
  } catch (e) {}
}

// Safe Contextual Polisher (Protected against ReDoS)
function ruleBasedPolish(text, tone = 'clean', dictionary = []) {
  if (!text || typeof text !== 'string') return '';
  let result = text.slice(0, 10000).trim();

  // 1. Apply custom dictionary replacements safely
  if (Array.isArray(dictionary)) {
    for (const item of dictionary.slice(0, 50)) {
      if (item && typeof item.phrase === 'string' && typeof item.replacement === 'string') {
        const safePhrase = item.phrase.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const safeReplacement = item.replacement.slice(0, 100);
        try {
          const regex = new RegExp(`\\b${safePhrase}\\b`, 'gi');
          result = result.replace(regex, safeReplacement);
        } catch (e) {}
      }
    }
  }

  // 2. Filler removal is allowed only for the explicitly aggressive "concise"
  // tone. The default "clean" tone must preserve every spoken word: deleting a
  // filler changes what the speaker actually said. Measured on real microphone
  // audio, unconditional removal turned "Um, I think, you know" into
  // "Let me think" and raised mean WER from 18.84% to 25.50%.
  if (tone === 'concise') {
    const fillers = [
      /\b(um|uh|erm|er|ah)\b,?\s*/gi,
      /\b(you know|basically|so yeah)\b,?\s*/gi
    ];
    for (const f of fillers) {
      result = result.replace(f, ' ');
    }
  }

  result = result.replace(/\s+/g, ' ').trim();

  // 3. Tone transformations
  if (tone === 'concise') {
    result = result
      .replace(/\bi wanted to say that\b/gi, '')
      .replace(/\bplease make sure that you\b/gi, 'Please')
      .trim();
  } else if (tone === 'professional') {
    result = result
      .replace(/\bgonna\b/gi, 'going to')
      .replace(/\bwanna\b/gi, 'want to')
      .replace(/\bthanks\b/gi, 'Thank you');
  } else if (tone === 'prompt') {
    result = `Task: ${result}\nRequirements:\n- Output clean and concise response.\n- Provide step-by-step reasoning.`;
    return result;
  } else if (tone === 'code') {
    return `// ${result}`;
  }

  // 4. Smart Capitalization & Punctuation
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
    if (!/[.!?]$/.test(result) && tone !== 'code') {
      result += '.';
    }
  }

  return result;
}

// ==========================================
// 🔌 API ROUTER
// ==========================================
const api = express.Router();

// GET /settings (Returns safe metadata, never leaks raw API keys)
api.get('/settings', (req, res) => {
  res.json(getClientSafeSettings());
});

// POST /settings (Input validation & sanitization)
api.post('/settings', (req, res) => {
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ error: 'Invalid settings body' });
  }
  saveSettings(req.body);
  res.json({ success: true, settings: getClientSafeSettings() });
});

// POST /transcribe (Rate limited, size limited, validated; auth enforced via requireAuth)
api.post('/transcribe', aiRateLimiter, async (req, res) => {
  // 🛡️ SECURITY (B2): provider keys are held server-side only. Client-supplied
  // key headers are no longer accepted.
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const audioBuffer = req.body;
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 500) {
    return res.status(400).json({ error: 'No audio data received or recording was too short.' });
  }

  if (audioBuffer.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Audio payload too large (max 10MB).' });
  }

  // Shared per-request transcription context. The language is only sent when
  // the client explicitly requests one; otherwise Whisper auto-detects.
  const dict = readJSON(DICTIONARY_FILE, inMemoryDictionary);
  const requestedLanguage = normalizeWhisperLanguage(req.headers['x-language']);
  const audioSeconds = wavDurationSeconds(audioBuffer);
  const vocabularyPrompt = audioSeconds >= 0.5 ? buildVocabularyPrompt(dict) : '';

  // 1. Groq Whisper
  if (groqKey) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', 'whisper-large-v3');
      formData.append('temperature', '0');
      formData.append('response_format', 'verbose_json');
      if (requestedLanguage) formData.append('language', requestedLanguage);
      if (vocabularyPrompt) formData.append('prompt', vocabularyPrompt);

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`
        },
        body: formData
      });

      if (response.ok) {
        const data = await response.json();
        const rawText = (data.text || '').trim();
        const formatted = ruleBasedPolish(rawText, 'clean', dict);
        const normalized = formatTranscriptText(rawText, dict);
        logWhisperMetadata('groq-whisper-large-v3', data, audioSeconds, Boolean(vocabularyPrompt));

        return res.json({
          text: rawText,
          formattedText: formatted,
          normalizedText: normalized,
          language: typeof data.language === 'string' ? data.language : null,
          provider: 'groq-whisper-large-v3'
        });
      }
    } catch (err) {
      console.error('Groq transcription error:', err.message);
    }
  }

  // 2. OpenAI Whisper
  if (openaiKey) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', 'whisper-1');
      formData.append('temperature', '0');
      formData.append('response_format', 'verbose_json');
      if (requestedLanguage) formData.append('language', requestedLanguage);
      if (vocabularyPrompt) formData.append('prompt', vocabularyPrompt);

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`
        },
        body: formData
      });

      if (response.ok) {
        const data = await response.json();
        const rawText = (data.text || '').trim();
        const formatted = ruleBasedPolish(rawText, 'clean', dict);
        const normalized = formatTranscriptText(rawText, dict);
        logWhisperMetadata('openai-whisper', data, audioSeconds, Boolean(vocabularyPrompt));

        return res.json({
          text: rawText,
          formattedText: formatted,
          normalizedText: normalized,
          language: typeof data.language === 'string' ? data.language : null,
          provider: 'openai-whisper'
        });
      }
    } catch (err) {
      console.error('OpenAI transcription error:', err.message);
    }
  }

  return res.status(400).json({
    error: 'No Whisper API key configured. Use browser Web Speech or add Groq API key in Settings.',
    hint: 'Groq provides free Whisper requests with instant setup at console.groq.com'
  });
});

// POST /polish (Input validation, tone allowlist, length limits)
api.post('/polish', aiRateLimiter, async (req, res) => {
  const { rawText, context = '', tone = 'clean', dictionary = [] } = req.body;
  // 🛡️ SECURITY (B2): provider keys are held server-side only. Client-supplied
  // key headers are no longer accepted. Groq takes precedence when configured.
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;

  if (!rawText || typeof rawText !== 'string') {
    return res.status(400).json({ error: 'Valid rawText string is required' });
  }

  if (rawText.length > 10000) {
    return res.status(400).json({ error: 'rawText exceeds maximum allowed length (10,000 characters)' });
  }

  const validTones = ['clean', 'concise', 'professional', 'prompt', 'code'];
  const safeTone = validTones.includes(tone) ? tone : 'clean';

  const userDictionary = Array.isArray(dictionary) && dictionary.length
    ? dictionary.slice(0, 50)
    : readJSON(DICTIONARY_FILE, inMemoryDictionary);

  if (apiKey) {
    try {
      const isGroq = Boolean(process.env.GROQ_API_KEY);
      const url = isGroq 
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';

      const promptToneMap = {
        clean: "Fix punctuation and sentence capitalization only. Do not add, remove, reorder, or replace any words. Keep filler words (um, uh, you know) exactly as spoken. The output must contain the same words in the same order as the input.",
        concise: "Transform the dictation into a punchy, highly concise summary without filler or fluff.",
        professional: "Polite, elegant executive prose suitable for business correspondence.",
        prompt: "Restructure this voice input into an optimized, structured prompt for an AI assistant with Goal, Context, and Format.",
        code: "Format as clean developer code comments or markdown code syntax."
      };

      const safeContext = typeof context === 'string' ? context.slice(0, 100) : 'general text editor';
      const safeVocabulary = userDictionary
        .filter(d => d && typeof d.phrase === 'string' && typeof d.replacement === 'string')
        .map(d => `${d.phrase.slice(0, 50)} -> ${d.replacement.slice(0, 50)}`)
        .join(', ');

      const systemPrompt = `You are Talkity's intelligent speech post-processing engine.
${promptToneMap[safeTone] || promptToneMap.clean}
Target App Context: "${safeContext}"
Custom Vocabulary: ${safeVocabulary}
Output ONLY the final polished text. Do not provide greetings, explanations, or quotes.`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: rawText.slice(0, 8000) }
          ],
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        const polished = data.choices[0]?.message?.content?.trim();
        if (polished) {
          return res.json({ formattedText: polished, provider: isGroq ? 'groq-llama3.3' : 'openai-gpt4o' });
        }
      }
    } catch (err) {
      console.warn('LLM API call failed, falling back to rule-based polisher:', err.message);
    }
  }

  const polished = ruleBasedPolish(rawText, safeTone, userDictionary);
  res.json({ formattedText: polished, provider: 'local-rules-engine' });
});

// GET /history
api.get('/history', (req, res) => {
  const history = readJSON(HISTORY_FILE, inMemoryHistory);
  res.json(history);
});

// POST /history (Validation & Sanitization)
api.post('/history', (req, res) => {
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ error: 'Invalid history body' });
  }

  const history = readJSON(HISTORY_FILE, inMemoryHistory);
  const newEntry = {
    id: 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    asrText: typeof req.body.asrText === 'string' ? req.body.asrText.slice(0, 5000) : '',
    formattedText: typeof req.body.formattedText === 'string' ? req.body.formattedText.slice(0, 5000) : '',
    tone: typeof req.body.tone === 'string' ? req.body.tone.slice(0, 30) : 'clean',
    duration: typeof req.body.duration === 'number' ? Math.max(0, Math.min(req.body.duration, 3600)) : 0,
    numWords: typeof req.body.formattedText === 'string' ? req.body.formattedText.trim().split(/\s+/).filter(Boolean).length : 0,
    app: typeof req.body.app === 'string' ? req.body.app.slice(0, 50) : 'Web Playground',
    latencyMs: typeof req.body.latencyMs === 'number' ? Math.max(0, Math.min(req.body.latencyMs, 60000)) : 250
  };

  history.unshift(newEntry);
  if (history.length > 100) history.pop();
  inMemoryHistory = history;
  writeJSON(HISTORY_FILE, history);
  broadcast({ type: 'history_update', entry: newEntry });
  res.json(newEntry);
});

// DELETE /history
api.delete('/history', (req, res) => {
  inMemoryHistory = [];
  writeJSON(HISTORY_FILE, []);
  broadcast({ type: 'history_cleared' });
  res.json({ success: true, message: 'History cleared' });
});

// GET /dictionary
api.get('/dictionary', (req, res) => {
  const dict = readJSON(DICTIONARY_FILE, inMemoryDictionary);
  res.json(dict);
});

// POST /dictionary (Length validation, rule count limit)
api.post('/dictionary', (req, res) => {
  const { phrase, replacement } = req.body;
  if (!phrase || !replacement || typeof phrase !== 'string' || typeof replacement !== 'string') {
    return res.status(400).json({ error: 'Phrase and replacement must be non-empty strings' });
  }

  const safePhrase = phrase.trim().slice(0, 100);
  const safeReplacement = replacement.trim().slice(0, 100);

  if (!safePhrase || !safeReplacement) {
    return res.status(400).json({ error: 'Phrase and replacement cannot be empty after trimming' });
  }

  const dict = readJSON(DICTIONARY_FILE, inMemoryDictionary);
  if (dict.length >= 100) {
    return res.status(400).json({ error: 'Maximum dictionary limit reached (100 rules)' });
  }

  dict.push({ phrase: safePhrase, replacement: safeReplacement });
  inMemoryDictionary = dict;
  writeJSON(DICTIONARY_FILE, dict);
  res.json({ success: true, dictionary: dict });
});

// DELETE /dictionary/:index
api.delete('/dictionary/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const dict = readJSON(DICTIONARY_FILE, inMemoryDictionary);
  if (Number.isInteger(idx) && idx >= 0 && idx < dict.length) {
    dict.splice(idx, 1);
    inMemoryDictionary = dict;
    writeJSON(DICTIONARY_FILE, dict);
  }
  res.json({ success: true, dictionary: dict });
});

// POST /inject (Safe text limits)
api.post('/inject', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Valid text string is required' });
  }

  const safeText = text.slice(0, 5000);
  broadcast({ type: 'inject_text', text: safeText });
  res.json({ success: true, message: 'Injection dispatched to desktop daemon' });
});

// GET /ws-status (WebSocket connection status)
api.get('/ws-status', (req, res) => {
  const stats = getWebSocketStats();
  res.json({
    ...stats,
    serverUptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Mount router on both /api and root — behind the authentication gate (B1).
app.use('/api', requireAuth, api);
app.use(requireAuth, api);

// Web playground (formerly the root page) keeps its own URL
app.get(['/app', '/playground'], (req, res) => {
  const appPath = path.join(publicPath, 'app.html');
  if (fs.existsSync(appPath)) {
    res.sendFile(appPath);
  } else {
    res.redirect('/');
  }
});

// Fallback: Serve index.html for root or non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  const indexPath = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send('Talkity API is running.');
  }
});

// Start listening only in standalone local mode (not in Vercel Serverless)
if (!IS_VERCEL && require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Talkity Web Server running at: http://localhost:${PORT}`);
    console.log(`🛡️ Security Headers & Rate Limiting Active`);
    console.log(`🎙️ WebSocket ready for live audio & desktop injection`);
    console.log(`======================================================\n`);
  });
}

// Expose pure helpers for tests and diagnostics. The exported value remains the
// Express app so Vercel/serverless entrypoints are unaffected.
app.locals.formatTranscriptText = formatTranscriptText;
app.locals.ruleBasedPolish = ruleBasedPolish;
app.locals.buildVocabularyPrompt = buildVocabularyPrompt;
app.locals.wavDurationSeconds = wavDurationSeconds;
app.locals.normalizeWhisperLanguage = normalizeWhisperLanguage;

module.exports = app;
