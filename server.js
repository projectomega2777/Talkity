const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!(process.env.VERCEL || process.env.NOW_REGION || process.env.LAMBDA_TASK_ROOT);

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
      "script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https://*.google.com https://*.googleusercontent.com https://*.googlesyndication.com",
      "media-src 'self' blob:",
      "connect-src 'self' https://api.groq.com https://api.openai.com wss: ws: https://pagead2.googlesyndication.com https://*.google.com https://*.googlesyndication.com",
      "frame-src 'self' https://googleads.g.doubleclick.net https://*.google.com https://*.googlesyndication.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
});

// 3. Strict CORS Configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://talkity.vercel.app'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, server-to-server) or matching allowed
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-groq-key', 'x-openai-key', 'x-language'],
  credentials: false
}));

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
  { phrase: "pi yush", replacement: "Piyush" },
  { phrase: "ui automation", replacement: "UI Automation" }
];
let inMemorySettings = {
  groqApiKey: process.env.GROQ_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
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

function getRawSettings() {
  const disk = readJSON(SETTINGS_FILE, null);
  if (disk) return disk;
  return inMemorySettings;
}

// 🛡️ SECURITY: Never expose plaintext API keys to clients via GET /settings
function getClientSafeSettings() {
  const s = getRawSettings();
  return {
    hasGroqKey: Boolean(s.groqApiKey || process.env.GROQ_API_KEY),
    hasOpenaiKey: Boolean(s.openaiApiKey || process.env.OPENAI_API_KEY),
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
  if (typeof settings.groqApiKey === 'string' && settings.groqApiKey.length <= 256) {
    sanitized.groqApiKey = settings.groqApiKey.trim();
  }
  if (typeof settings.openaiApiKey === 'string' && settings.openaiApiKey.length <= 256) {
    sanitized.openaiApiKey = settings.openaiApiKey.trim();
  }
  inMemorySettings = { ...inMemorySettings, ...sanitized };
  writeJSON(SETTINGS_FILE, inMemorySettings);
}

// WebSocket setup (Local standalone only)
const clients = new Map(); // Map<WebSocket, clientMetadata>
let desktopClient = null;

// Heartbeat monitoring configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 35000; // 35 seconds (give 5s grace period)

if (!IS_VERCEL) {
  try {
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      const clientMeta = {
        id: `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: Date.now(),
        isDesktop: false,
        isAlive: true
      };

      clients.set(ws, clientMeta);
      console.log(`[WebSocket] Client connected: ${clientMeta.id}`);

      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Talkity WebSocket connected',
        clientId: clientMeta.id,
        serverTime: new Date().toISOString()
      }));

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

          // Desktop client registration
          if (data.type === 'register_desktop') {
            desktopClient = ws;
            if (clients.has(ws)) {
              clients.get(ws).isDesktop = true;
              clients.get(ws).clientId = data.clientId || clientMeta.id;
            }
            console.log(`[WebSocket] Desktop client registered: ${data.clientId}`);
            broadcast({ type: 'desktop_status', connected: true, clientId: data.clientId });
            return;
          }

          // Broadcast to other clients
          for (const [client, meta] of clients.entries()) {
            if (client !== ws && client.readyState === 1) {
              client.send(JSON.stringify(data));
            }
          }
        } catch (e) {
          console.error('[WebSocket] Message error:', e.message);
        }
      });

      ws.on('close', () => {
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
    if (client.readyState === 1) {
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

  // 2. Remove filler words safely
  const fillers = [
    /\b(um|uh|erm|er|ah)\b,?\s*/gi,
    /\b(you know|basically|so yeah)\b,?\s*/gi
  ];
  for (const f of fillers) {
    result = result.replace(f, ' ');
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

// POST /transcribe (Rate limited, size limited, validated)
api.post('/transcribe', aiRateLimiter, async (req, res) => {
  const rawSettings = getRawSettings();
  const groqKey = (typeof req.headers['x-groq-key'] === 'string' ? req.headers['x-groq-key'].trim() : '') || rawSettings.groqApiKey || process.env.GROQ_API_KEY;
  const openaiKey = (typeof req.headers['x-openai-key'] === 'string' ? req.headers['x-openai-key'].trim() : '') || rawSettings.openaiApiKey || process.env.OPENAI_API_KEY;

  const audioBuffer = req.body;
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 500) {
    return res.status(400).json({ error: 'No audio data received or recording was too short.' });
  }

  if (audioBuffer.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Audio payload too large (max 10MB).' });
  }

  // 1. Groq Whisper
  if (groqKey) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', 'whisper-large-v3');
      formData.append('temperature', '0');

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
        const dict = readJSON(DICTIONARY_FILE, inMemoryDictionary);
        const formatted = ruleBasedPolish(rawText, 'clean', dict);

        return res.json({
          text: rawText,
          formattedText: formatted,
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
        const dict = readJSON(DICTIONARY_FILE, inMemoryDictionary);
        const formatted = ruleBasedPolish(rawText, 'clean', dict);
        return res.json({
          text: rawText,
          formattedText: formatted,
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
  const rawSettings = getRawSettings();
  const apiKey = (typeof req.headers['x-groq-key'] === 'string' ? req.headers['x-groq-key'].trim() : '') || rawSettings.groqApiKey || process.env.GROQ_API_KEY || (typeof req.headers['x-openai-key'] === 'string' ? req.headers['x-openai-key'].trim() : '') || rawSettings.openaiApiKey || process.env.OPENAI_API_KEY;

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
      const isGroq = !!((typeof req.headers['x-groq-key'] === 'string' && req.headers['x-groq-key'].trim()) || rawSettings.groqApiKey || process.env.GROQ_API_KEY);
      const url = isGroq 
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';

      const promptToneMap = {
        clean: "Clean up raw dictation: remove filler words (um, uh, like), fix punctuation, restore sentence capitalization. Preserve the user's natural speaking style.",
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

// Mount router on both /api and root
app.use('/api', api);
app.use(api);

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

module.exports = app;
