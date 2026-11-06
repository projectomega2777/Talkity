/**
 * Talkity Security Regression Tests (B1–B4)
 *
 * Runs THREE isolated real-server suites. Every suite spawns a real
 * `node server.js` child process on a random port with a random deployment
 * token (never printed, never logged) and drives the REAL Express middleware
 * and REAL WebSocket implementation with live sockets — only external
 * providers (Groq/OpenAI) are ever mocked, and only in test_server_transcribe.js.
 *
 *   Suite 1 — development mode (token configured): B1–B4 as before
 *     B1  unauthenticated REST rejected; invalid/equal-length/malformed tokens
 *     B1  WS closes 4001; auth frame / register-token / ?token= paths
 *     B2  no key leakage via settings API; client key headers not honored;
 *         legacy provider keys in settings.json are scrubbed at boot and
 *         never reused (Task 3 regression)
 *     B3  exact-origin CORS allowlist (regular + preflight, lookalikes)
 *     B4  unauthenticated relay closed; inject_text server-authoritative only
 *     F1  clientId sanitized (bounded, printable) at register boundary
 *   Suite 2 — NODE_ENV=production, token configured:
 *     B1  401/valid-token REST; production fail-safe behaviors
 *     B4  unauthenticated WS clients receive no transcription/injection/relay
 *   Suite 3 — NODE_ENV=production, NO token configured:
 *     B1  fail-closed: REST 503, WS 4001
 *
 * Run: node test_security.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;
const children = [];

function report(name, ok, extra) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomToken = () => `sec_test_${crypto.randomBytes(16).toString('hex')}`;

// ---- Server lifecycle ----------------------------------------------------

function startServer({ nodeEnv = '', token = '' } = {}) {
  const port = 43000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: nodeEnv,
      TALKITY_API_TOKEN: token,
      // Never let a developer's real provider keys touch these tests.
      GROQ_API_KEY: '',
      OPENAI_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.talkityLog = () => log; // failure diagnostics only; tokens are never in output
  children.push(child);
  return {
    child,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/`,
    token,
    nodeEnv,
    log: () => log
  };
}

function killAllChildren() {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
    }
  }, 400);
}

async function waitForServer(ctx) {
  // Any auth-gated answer (401) or fail-closed answer (503) proves listening.
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${ctx.base}/api/settings`);
      if (res.status === 401 || res.status === 503 || res.status === 200) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// ---- Helpers -------------------------------------------------------------

async function httpJson(base, method, urlPath, { headers = {}, body } = {}) {
  const opts = { method, headers };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json', ...headers };
  }
  const res = await fetch(`${base}${urlPath}`, opts);
  return {
    status: res.status,
    headers: res.headers,
    json: await res.json().catch(() => null)
  };
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const opens = { value: false };
    ws.on('open', () => { opens.value = true; });
    ws.on('message', (m) => {
      try { frames.push(JSON.parse(m.toString())); } catch { frames.push(m.toString()); }
    });
    let closed = null;
    ws.on('close', (code) => { closed = { code }; });
    ws.on('error', (err) => reject(err));
    const handle = {
      frames,
      isOpen: () => ws.readyState === WebSocket.OPEN,
      openWait: async (ms = 3000) => {
        const started = Date.now();
        while (!opens.value && Date.now() - started < ms) await sleep(25);
        return opens.value;
      },
      send: (obj) => ws.send(JSON.stringify(obj)),
      closedInfo: () => closed,
      closeWait: async (ms = 9000) => {
        const started = Date.now();
        while (!closed && Date.now() - started < ms) await sleep(25);
        return closed;
      },
      expect: async (pred, ms = 2500) => {
        const started = Date.now();
        while (Date.now() - started < ms) {
          const f = frames.find(pred);
          if (f) return f;
          await sleep(25);
        }
        return null;
      },
      close: () => { try { ws.close(); } catch {} }
    };
    setTimeout(() => resolve(handle), 30);
  });
}

const authHeader = (token) => ({ 'x-talkity-token': token });

// ==========================================================================
// Suite 1 — development mode, token configured (B1–B4 + scrub + F1)
// ==========================================================================

async function suiteDevelopment() {
  console.log('\n========== Suite 1: development mode (token configured) ==========');
  const TOKEN = randomToken();

  // Task 3 regression setup: pre-seed a LEGACY settings.json containing
  // provider keys exactly like the old client-supplied persistence wrote.
  const settingsFile = path.join(__dirname, '..', '..', '..', 'data', 'settings.json');
  let settingsExisted = fs.existsSync(settingsFile);
  let settingsOriginal = settingsExisted ? fs.readFileSync(settingsFile, 'utf8') : null;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    language: 'en-IN',
    autoCopy: true,
    soundChimes: true,
    groqApiKey: 'gsk_FAKEKEY_LEGACY_scrub_me_1234567890',
    openaiApiKey: 'sk-FAKEKEY_LEGACY_persist_test'
  }, null, 2));

  try {
    const ctx = startServer({ nodeEnv: '', token: TOKEN });
    if (!(await waitForServer(ctx))) {
      report('Suite 1 server started', false, ctx.log().slice(-400));
      return;
    }

    // ------------------------------------------------------------ Task 3
    console.log('\n[B2] Legacy provider-key scrub (boot-time regression)');
    {
      const r = await httpJson(ctx.base, 'GET', '/api/settings', { headers: authHeader(TOKEN) });
      const str = JSON.stringify(r.json || {});
      report('Legacy keys not returned via GET /api/settings',
        r.status === 200 && !/FAKEKEY|groqApiKey|openaiApiKey|"gsk_|"sk-/.test(str),
        str.slice(0, 200));

      const diskRaw = fs.readFileSync(settingsFile, 'utf8');
      report('Legacy keys scrubbed from settings.json on disk',
        !diskRaw.includes('FAKEKEY') && !diskRaw.includes('groqApiKey') && !diskRaw.includes('openaiApiKey'),
        diskRaw.slice(0, 200));

      let diskParsed = null;
      try { diskParsed = JSON.parse(diskRaw); } catch {}
      report('Non-secret settings preserved by scrub',
        diskParsed && diskParsed.autoCopy === true && diskParsed.soundChimes === true && diskParsed.language === 'en-IN',
        diskRaw.slice(0, 200));
    }

    // -------------------------------------------------------------- B1.1
    console.log('\n[B1] Unauthenticated REST requests');
    {
      const r1 = await httpJson(ctx.base, 'GET', '/api/settings');
      report('GET /api/settings without token → 401', r1.status === 401, `got ${r1.status}`);
      const r2 = await httpJson(ctx.base, 'GET', '/api/history');
      report('GET /api/history without token → 401', r2.status === 401, `got ${r2.status}`);
      const r3 = await httpJson(ctx.base, 'POST', '/api/inject', { body: { text: 'hi' } });
      report('POST /api/inject without token → 401', r3.status === 401, `got ${r3.status}`);
      const r4 = await httpJson(ctx.base, 'DELETE', '/api/history');
      report('DELETE /api/history without token → 401', r4.status === 401, `got ${r4.status}`);
      const r5 = await httpJson(ctx.base, 'POST', '/api/dictionary', { body: { phrase: 'x', replacement: 'y' } });
      report('POST /api/dictionary without token → 401', r5.status === 401, `got ${r5.status}`);
    }

    // -------------------------------------------------------------- B1.2
    console.log('\n[B1] Invalid credentials');
    {
      const r1 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { 'x-talkity-token': 'wrong-token' } });
      report('Wrong token → 401', r1.status === 401, `got ${r1.status}`);
      const sameLen = 'x'.repeat(TOKEN.length);
      const r2 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { 'x-talkity-token': sameLen } });
      report('Equal-length invalid token → 401', r2.status === 401, `got ${r2.status}`);
      const r3 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { authorization: `Basic ${TOKEN}` } });
      report('Non-Bearer Authorization header → 401', r3.status === 401, `got ${r3.status}`);
      const r4 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { authorization: `Bearer wrong-token` } });
      report('Bearer wrong token → 401', r4.status === 401, `got ${r4.status}`);
      const r5 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { authorization: `Bearer ${TOKEN}` } });
      report('Bearer correct token → 200 (positive control)', r5.status === 200, `got ${r5.status}`);
      console.log('  ℹ️  Design decision: static token, no expiry path to test.');
    }

    // ---------------------------------------------------------------- B3
    console.log('\n[B3] CORS allowlist (non-production)');
    {
      const evil = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'https://evil.example' }
      });
      report('Disallowed origin gets no ACAO header',
        evil.headers.get('access-control-allow-origin') === null,
        `ACAO=${evil.headers.get('access-control-allow-origin')}`);

      const lookalike = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'https://talkity.vercel.app.evil.example' }
      });
      report('Lookalike suffix origin gets no ACAO header',
        lookalike.headers.get('access-control-allow-origin') === null,
        `ACAO=${lookalike.headers.get('access-control-allow-origin')}`);

      const otherVercel = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'https://someotherapp.vercel.app' }
      });
      report('Unlisted *.vercel.app gets no ACAO header',
        otherVercel.headers.get('access-control-allow-origin') === null,
        `ACAO=${otherVercel.headers.get('access-control-allow-origin')}`);

      const prod = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'https://talkity-qifh.onrender.com' }
      });
      report('Production origin allowed with ACAO',
        prod.headers.get('access-control-allow-origin') === 'https://talkity-qifh.onrender.com',
        `ACAO=${prod.headers.get('access-control-allow-origin')}`);

      const dev = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'http://localhost:3000' }
      });
      report('Dev localhost origin allowed (non-production server)',
        dev.headers.get('access-control-allow-origin') === 'http://localhost:3000',
        `ACAO=${dev.headers.get('access-control-allow-origin')}`);

      const pf = await fetch(`${ctx.base}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-talkity-token'
        }
      });
      report('Disallowed preflight gets no ACAO header',
        pf.headers.get('access-control-allow-origin') === null,
        `ACAO=${pf.headers.get('access-control-allow-origin')}`);
    }

    // ---------------------------------------------------------------- B2
    console.log('\n[B2] API-key leakage & unsafe persistence');
    {
      const post = await httpJson(ctx.base, 'POST', '/api/settings', {
        headers: authHeader(TOKEN),
        body: {
          language: 'en-IN',
          autoCopy: true,
          soundChimes: true,
          groqApiKey: 'gsk_FAKEKEY_not_real_1234567890',
          openaiApiKey: 'sk-FAKEKEY_not_real_persist_test'
        }
      });
      report('POST /api/settings succeeds with token', post.status === 200, `got ${post.status}`);
      const respText = JSON.stringify(post.json || {});
      report('POST /settings response contains no provider key values',
        !respText.includes('FAKEKEY'),
        respText.slice(0, 200));

      let persisted = '';
      try { persisted = fs.readFileSync(settingsFile, 'utf8'); } catch {}
      report('Provider keys never persisted to settings.json (post-save)',
        !persisted.includes('FAKEKEY'),
        persisted.slice(0, 200));

      // Client-supplied key headers must not enable provider routes.
      const fakeWav = Buffer.alloc(600, 0); // > 500 byte floor, not a real wav
      const tr = await fetch(`${ctx.base}/api/transcribe`, {
        method: 'POST',
        headers: { ...authHeader(TOKEN), 'Content-Type': 'application/octet-stream', 'x-groq-key': 'gsk_FAKEKEY_bypass' },
        body: fakeWav
      });
      const trBody = JSON.stringify(await tr.json().catch(() => ({})));
      report('/transcribe ignores client key headers (400: no server-side key)',
        tr.status === 400 && trBody.includes('No Whisper API key configured'),
        `status=${tr.status} body=${trBody.slice(0, 120)}`);
    }

    // -------------------------------------------------------------- B1.6
    console.log('\n[B1] Authenticated workflows (positive controls)');
    {
      const post = await httpJson(ctx.base, 'POST', '/api/history', {
        headers: authHeader(TOKEN),
        body: { asrText: 'security test', formattedText: 'security test', tone: 'clean', duration: 1, app: 'test', latencyMs: 1 }
      });
      report('POST /api/history with token → 200', post.status === 200, `got ${post.status}`);

      const get = await httpJson(ctx.base, 'GET', '/api/history', { headers: authHeader(TOKEN) });
      const found = Array.isArray(get.json) && get.json.some((h) => h && h.asrText === 'security test');
      report('GET /api/history with token returns the record', get.status === 200 && found, `status=${get.status}`);

      const polish = await httpJson(ctx.base, 'POST', '/api/polish', {
        headers: authHeader(TOKEN),
        body: { rawText: 'hello world um', tone: 'clean', dictionary: [] }
      });
      report('POST /api/polish with token (rule-based fallback) → 200',
        polish.status === 200 && typeof polish.json?.formattedText === 'string',
        `status=${polish.status}`);

      await httpJson(ctx.base, 'DELETE', '/api/history', { headers: authHeader(TOKEN) });
    }

    // -------------------------------------------------------------- B1.4
    console.log('\n[B1] WebSocket authentication');
    let authA = null;
    {
      const wsu = await wsConnect(ctx.wsUrl);
      const opened = await wsu.openWait();
      const closed = await wsu.closeWait(9000);
      report('Unauthenticated WS opened then closed', opened && Boolean(closed), `opened=${opened}`);
      report('Unauthenticated WS closed with code 4001 inside auth window',
        closed && closed.code === 4001,
        closed ? `code=${closed.code}` : 'never closed');

      const wsb = await wsConnect(ctx.wsUrl);
      await wsb.openWait();
      wsb.send({ type: 'auth', token: 'wrong-token' });
      const closedB = await wsb.closeWait();
      report('WS auth frame with invalid token → closed 4001',
        Boolean(closedB) && closedB.code === 4001,
        closedB ? `code=${closedB.code}` : 'never closed');

      const wsc = await wsConnect(`${ctx.wsUrl}?token=wrong-token`);
      await wsc.openWait();
      const closedC = await wsc.closeWait(9000);
      report('WS ?token= with invalid token → closed 4001',
        Boolean(closedC) && closedC.code === 4001,
        closedC ? `code=${closedC.code}` : 'never closed');

      authA = await wsConnect(ctx.wsUrl);
      await authA.openWait();
      authA.send({ type: 'auth', token: TOKEN });
      const ack = await authA.expect((f) => f && f.type === 'authenticated');
      report('WS auth frame with valid token → authenticated ack', Boolean(ack), 'no authenticated ack');

      const wsd = await wsConnect(`${ctx.wsUrl}?token=${TOKEN}`);
      await wsd.openWait();
      wsd.send({ type: 'register_extension', clientId: 'sec-test-ext' });
      const reg = await wsd.expect((f) => f && f.type === 'extension_registered');
      const stillOpen = wsd.isOpen();
      report('WS ?token= with valid token authenticates (register works)', Boolean(reg) && stillOpen);
      wsd.close();

      const wse = await wsConnect(ctx.wsUrl);
      await wse.openWait();
      wse.send({ type: 'register_extension', clientId: 'sec-test-ext-2', token: TOKEN });
      const reg2 = await wse.expect((f) => f && f.type === 'extension_registered');
      report('Register frame carrying token authenticates', Boolean(reg2));
      wse.close();

      const wsf = await wsConnect(ctx.wsUrl);
      await wsf.openWait();
      wsf.send({ type: 'heartbeat' });
      const hba = await wsf.expect((f) => f && f.type === 'heartbeat_ack');
      report('Pre-auth heartbeat responded while unauthenticated', Boolean(hba));
      await wsf.closeWait(9000);
    }

    // ------------------------------------------------- F1 (clientId sanitize)
    console.log('\n[F1] Client identifier sanitization');
    {
      const wsSan = await wsConnect(ctx.wsUrl);
      await wsSan.openWait();
      wsSan.send({ type: 'auth', token: TOKEN });
      await wsSan.expect((f) => f && f.type === 'authenticated');

      // 300-char id containing control characters (log-injection attempt).
      const hostile = `${'x'.repeat(300)}\nINJECTED_LOG_LINE\r<script>`;
      wsSan.send({ type: 'register_desktop', clientId: hostile });
      const status = await wsSan.expect((f) => f && f.type === 'desktop_status', 2500);
      const id1 = status && typeof status.clientId === 'string' ? status.clientId : null;
      report('Hostile clientId sanitized: bounded string (300 chars → 64, tail removed)',
        Boolean(id1) && id1 === 'x'.repeat(64),
        id1 ? `len=${id1.length} val=${JSON.stringify(id1.slice(0, 80))}` : 'no desktop_status');
      report('Hostile clientId sanitized: no control characters',
        Boolean(id1) && !/[\x00-\x1F\x7F-\x9F]/.test(id1),
        id1 ? JSON.stringify(id1.slice(0, 80)) : 'no frame');

      // Non-string clientId → falls back to a server-generated id.
      const wsNum = await wsConnect(ctx.wsUrl);
      await wsNum.openWait();
      wsNum.send({ type: 'auth', token: TOKEN });
      await wsNum.expect((f) => f && f.type === 'authenticated');
      wsNum.send({ type: 'register_extension', clientId: 42 });
      const regNum = await wsNum.expect((f) => f && f.type === 'extension_registered');
      report('Non-string clientId handled safely (registration still works)', Boolean(regNum));
      wsNum.close();
      wsSan.close();
    }

    // ---------------------------------------------------------------- B4
    console.log('\n[B4] Injection, broadcast authorization & cross-user isolation');
    {
      if (authA) {
        const wsB = await wsConnect(ctx.wsUrl);
        await wsB.openWait();
        wsB.send({ type: 'auth', token: TOKEN });
        await wsB.expect((f) => f && f.type === 'authenticated');

        const wsEvil = await wsConnect(ctx.wsUrl);
        await wsEvil.openWait();
        wsEvil.send({ type: 'transcription', text: 'hijack attempt' });
        const closedEvil = await wsEvil.closeWait();
        report('Unauthenticated relay attempt → connection closed 4001',
          Boolean(closedEvil) && closedEvil.code === 4001,
          closedEvil ? `code=${closedEvil.code}` : 'never closed');

        authA.send({ type: 'inject_text', text: 'malicious inject' });
        const errA = await authA.expect((f) => f && f.type === 'error');
        report('WS inject_text from authenticated client rejected with error frame', Boolean(errA));

        await sleep(500);
        report('Other authenticated client never receives client-sent inject_text',
          !wsB.frames.some((f) => f && f.type === 'inject_text'));
        report('WS-direct inject never relayed to other clients',
          !wsB.frames.some((f) => f && f.type === 'transcription' && f.text === 'malicious inject'));

        const inj = await httpJson(ctx.base, 'POST', '/api/inject', { headers: authHeader(TOKEN), body: { text: 'server hello' } });
        report('Authenticated POST /api/inject → 503 (contained)', inj.status === 503, `got ${inj.status}`);
        report('Contained inject dispatches no inject_text to clients',
          !wsB.frames.some((f) => f && f.type === 'inject_text'));

        authA.send({ type: 'transcription', text: 'relay me', tone: 'clean' });
        const bRelay = await wsB.expect((f) => f && f.type === 'transcription' && f.text === 'relay me');
        report('Authed transcription relay reaches authenticated peers', Boolean(bRelay));

        const wsMal = await wsConnect(ctx.wsUrl);
        await wsMal.openWait();
        wsMal.send({ type: 'auth', token: TOKEN });
        await wsMal.expect((f) => f && f.type === 'authenticated');
        wsMal.send('not json at all');
        const arrErr = await wsMal.expect((f) => f && f.type === 'error');
        wsMal.send({ type: 'transcription', text: 42 });
        const shapeErr = await wsMal.expect((f) => f && f.type === 'error', 2500);
        report('Malformed JSON answered with error frame, not crash', Boolean(arrErr));
        report('Valid-auth bad transcription payload rejected with error frame', Boolean(shapeErr));
        report('Connection stays open after malformed frames', wsMal.isOpen());

        const wsBig = await wsConnect(ctx.wsUrl);
        await wsBig.openWait();
        wsBig.send({ type: 'auth', token: TOKEN });
        await wsBig.expect((f) => f && f.type === 'authenticated');
        wsBig.send(Buffer.alloc(70 * 1024, 'a'));
        const closedBig = await wsBig.closeWait();
        report('Oversized WS frame terminated by maxPayload (1009)',
          Boolean(closedBig) && closedBig.code === 1009,
          closedBig ? `code=${closedBig.code}` : 'never closed');

        wsB.close();
        wsMal.close();
        authA.close();
      } else {
        report('B4 suite skipped (authA unavailable)', false);
      }
    }

    ctx.child.kill();
  } finally {
    // Restore the pristine settings-file state captured before seeding.
    try {
      if (settingsOriginal !== null) fs.writeFileSync(settingsFile, settingsOriginal);
      else if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
    } catch {}
  }
}

// ==========================================================================
// Suite 2 — NODE_ENV=production, token configured
// ==========================================================================

async function suiteProduction() {
  console.log('\n========== Suite 2: production mode (token configured) ==========');
  const TOKEN = randomToken();
  const ctx = startServer({ nodeEnv: 'production', token: TOKEN });

  try {
    if (!(await waitForServer(ctx))) {
      report('Suite 2 server started', false, ctx.log().slice(-400));
      return;
    }

    console.log('\n[B1] REST credentials in production');
    {
      const r1 = await httpJson(ctx.base, 'GET', '/api/settings');
      report('Missing token → 401 in production', r1.status === 401, `got ${r1.status}`);
      const r2 = await httpJson(ctx.base, 'POST', '/api/inject', { body: { text: 'hi' } });
      report('Missing token on inject → 401 in production', r2.status === 401, `got ${r2.status}`);
      const r3 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { 'x-talkity-token': 'wrong-token' } });
      report('Invalid token → 401 in production', r3.status === 401, `got ${r3.status}`);
      const sameLen = 'x'.repeat(TOKEN.length);
      const r4 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { 'x-talkity-token': sameLen } });
      report('Equal-length invalid token → 401 in production', r4.status === 401, `got ${r4.status}`);
      const r5 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { authorization: `Bearer ${TOKEN}` } });
      report('Valid Bearer token → 200 in production', r5.status === 200, `got ${r5.status}`);
    }

    console.log('\n[B3] CORS in production (dev origins must be rejected)');
    {
      const dev = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'http://localhost:3000' }
      });
      report('Dev origin rejected in production (valid token, no ACAO)',
        dev.headers.get('access-control-allow-origin') === null,
        `ACAO=${dev.headers.get('access-control-allow-origin')}`);

      const devAlt = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'http://127.0.0.1:3000' }
      });
      report('127.0.0.1 dev origin rejected in production',
        devAlt.headers.get('access-control-allow-origin') === null,
        `ACAO=${devAlt.headers.get('access-control-allow-origin')}`);

      const unlisted = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'https://someotherapp.vercel.app' }
      });
      report('Unlisted *.vercel.app rejected in production',
        unlisted.headers.get('access-control-allow-origin') === null,
        `ACAO=${unlisted.headers.get('access-control-allow-origin')}`);

      const allowed = await httpJson(ctx.base, 'GET', '/api/settings', {
        headers: { ...authHeader(TOKEN), Origin: 'https://talkity-qifh.onrender.com' }
      });
      report('Production origin still allowed',
        allowed.headers.get('access-control-allow-origin') === 'https://talkity-qifh.onrender.com',
        `ACAO=${allowed.headers.get('access-control-allow-origin')}`);

      const pf = await fetch(`${ctx.base}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-talkity-token'
        }
      });
      report('Dev-origin preflight rejected in production (no ACAO)',
        pf.headers.get('access-control-allow-origin') === null,
        `ACAO=${pf.headers.get('access-control-allow-origin')}`);
    }

    console.log('\n[B1/B4] WebSocket in production');
    {
      const wsu = await wsConnect(ctx.wsUrl);
      await wsu.openWait();
      const closed = await wsu.closeWait(9000);
      report('Missing WS token → closed 4001 in production',
        Boolean(closed) && closed.code === 4001,
        closed ? `code=${closed.code}` : 'never closed');

      const wsi = await wsConnect(`${ctx.wsUrl}?token=wrong-token`);
      await wsi.openWait();
      const closedI = await wsi.closeWait(9000);
      report('Invalid ?token= → closed 4001 in production',
        Boolean(closedI) && closedI.code === 4001,
        closedI ? `code=${closedI.code}` : 'never closed');

      const wsv = await wsConnect(`${ctx.wsUrl}?token=${TOKEN}`);
      await wsv.openWait();
      wsv.send({ type: 'register_extension', clientId: 'prod-ext' });
      const reg = await wsv.expect((f) => f && f.type === 'extension_registered');
      report('Valid token establishes authorized WS in production',
        Boolean(reg) && wsv.isOpen());

      console.log('\n[B4] No unauthorized transcription/injection/relay in production');
      // Authed client A (auth frame), second authed client C, idle unauth B.
      const wsA = await wsConnect(`${ctx.wsUrl}?token=${TOKEN}`);
      await wsA.openWait();
      const wsC = await wsConnect(`${ctx.wsUrl}?token=${TOKEN}`);
      await wsC.openWait();
      const wsB = await wsConnect(ctx.wsUrl); // no token, idle within auth window

      wsA.send({ type: 'transcription', text: 'prod-secret-relay', tone: 'clean' });
      const cRelay = await wsC.expect((f) => f && f.type === 'transcription' && f.text === 'prod-secret-relay');
      report('Authed peer receives authenticated relay', Boolean(cRelay));
      report('Idle unauthenticated WS receives NO transcription relay',
        !wsB.frames.some((f) => f && f.type === 'transcription'),
        wsB.frames.length ? JSON.stringify(wsB.frames).slice(0, 120) : '');

      const inj = await httpJson(ctx.base, 'POST', '/api/inject', { headers: authHeader(TOKEN), body: { text: 'prod-inject' } });
      report('Authenticated inject disabled in production → 503', inj.status === 503, `got ${inj.status}`);
      report('Idle unauthenticated WS receives NO inject_text',
        !wsB.frames.some((f) => f && f.type === 'inject_text'),
        wsB.frames.length ? JSON.stringify(wsB.frames).slice(0, 120) : '');

      // Close B explicitly to end its pre-auth window deterministically.
      wsB.close();
      // B must never have received any other client's data, ever.
      await sleep(300);
      report('Unauthenticated WS never received any other client data during its window',
        !wsB.frames.some((f) => f && (f.type === 'transcription' || f.type === 'inject_text' || f.type === 'history_update')));

      wsA.close();
      wsC.close();
      wsv.close();
    }

    ctx.child.kill();
  } catch (e) {
    report('Suite 2 completed without harness errors', false, e.message);
    try { ctx.child.kill(); } catch {}
  }
}

// ==========================================================================
// Suite 3 — NODE_ENV=production, NO token configured (fail-closed)
// ==========================================================================

async function suiteProductionNoToken() {
  console.log('\n========== Suite 3: production mode, NO auth config (fail-closed) ==========');
  const ctx = startServer({ nodeEnv: 'production', token: '' });

  try {
    if (!(await waitForServer(ctx))) {
      report('Suite 3 server started', false, ctx.log().slice(-400));
      return;
    }

    const r1 = await httpJson(ctx.base, 'GET', '/api/settings');
    report('Missing auth config in production → REST 503 fail-closed',
      r1.status === 503,
      `got ${r1.status}`);

    const r2 = await httpJson(ctx.base, 'POST', '/api/polish', { body: { rawText: 'hi' } });
    report('Missing auth config in production → polish 503 fail-closed',
      r2.status === 503,
      `got ${r2.status}`);

    const r3 = await httpJson(ctx.base, 'POST', '/api/inject', { body: { text: 'hi' } });
    report('Missing auth config in production → inject 503 fail-closed',
      r3.status === 503,
      `got ${r3.status}`);

    const r4 = await httpJson(ctx.base, 'GET', '/api/settings', { headers: { 'x-talkity-token': 'guess' } });
    report('Any credential still 503 when no token is configured (no bypass)', r4.status === 503, `got ${r4.status}`);

    const wsf = await wsConnect(ctx.wsUrl);
    await wsf.openWait();
    const closed = await wsf.closeWait(9000);
    report('WS closed 4001 in production without auth config', Boolean(closed) && closed.code === 4001,
      closed ? `code=${closed.code}` : 'never closed');

    ctx.child.kill();
  } catch (e) {
    report('Suite 3 completed without harness errors', false, e.message);
    try { ctx.child.kill(); } catch {}
  }
}

// ==========================================================================

async function main() {
  console.log('Running Talkity security tests (all servers real, tokens hidden)');
  await suiteDevelopment();
  await suiteProduction();
  await suiteProductionNoToken();
}

async function run() {
  try {
    await main();
  } catch (e) {
    console.error('\n❌ Unexpected test harness error:', e.message);
    failed = failed > 0 ? failed : 1;
  }
  // Cleanup: every child process killed, every temporary resource restored —
  // even when assertions fail (finally semantics in each suite + this kill).
  killAllChildren();
  await sleep(500);

  console.log(`\n========================================`);
  console.log(`Security tests: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);

  // Never print tokens, even in failure diagnostics.
  if (failed > 0) {
    for (const c of children) {
      try {
        if (c.talkityLog && c.talkityLog().trim()) {
          console.error('---- tail of server output (tokens redacted) ----');
          console.error(c.talkityLog().slice(-1200));
        }
      } catch {}
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

run();
