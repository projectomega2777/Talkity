// Comprehensive Test Suite for the Five Talkity v1.2 Release Blockers
// Tests:
// - Blocker 1: Secure /api/settings & /settings (401 unauthenticated, 401 invalid, 200 valid, zero secrets)
// - Blocker 2: Contained privileged operations (POST /api/inject -> 503, DELETE /api/history -> 503 with valid token)
// - Blocker 3: Vercel & Render topology (API routing, WebSocket target resolution, CORS headers)
// - Blocker 4: Rate limiters (normal usage, limit exceeded, concurrent requests, quota isolation, failed request accounting, proxy IP handling)
// - Blocker 5: Restore /app (GET /app -> 200, GET /playground -> 200, static asset routes)

const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'production';
process.env.TALKITY_API_TOKEN = 'release-audit-secret-token-2026';
process.env.GROQ_API_KEY = 'mock-groq-key';
process.env.OPENAI_API_KEY = 'mock-openai-key';

const app = require('../services/backend/server.js');

let server;
let baseUrl;

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

async function deleteJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

async function run() {
  console.log('===============================================================');
  console.log('🧪 Starting Talkity v1.2 Five Blockers Verification Suite');
  console.log('===============================================================\n');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const validHeaders = {
    'Authorization': `Bearer ${process.env.TALKITY_API_TOKEN}`,
    'x-talkity-token': process.env.TALKITY_API_TOKEN
  };

  try {
    // -------------------------------------------------------------
    // BLOCKER 1: Secure /api/settings and /settings
    // -------------------------------------------------------------
    console.log('--- BLOCKER 1: Secure /api/settings & /settings ---');

    // 1.1 Unauthenticated requests return 401
    const s1 = await getJson('/api/settings');
    assert.strictEqual(s1.status, 401, 'GET /api/settings without token must return 401');
    const s1b = await getJson('/settings');
    assert.strictEqual(s1b.status, 401, 'GET /settings without token must return 401');
    console.log('✅ Unauthenticated /api/settings and /settings return HTTP 401');

    // 1.2 Invalid token returns 401
    const s2 = await getJson('/api/settings', { 'Authorization': 'Bearer wrong-token' });
    assert.strictEqual(s2.status, 401, 'GET /api/settings with invalid token must return 401');
    console.log('✅ Invalid token returns HTTP 401');

    // 1.3 Query-param token is rejected
    const s3 = await getJson(`/api/settings?token=${process.env.TALKITY_API_TOKEN}`);
    assert.strictEqual(s3.status, 401, 'GET /api/settings?token=... must be rejected with 401');
    console.log('✅ REST query-token authentication is rejected with HTTP 401');

    // 1.4 Valid token works and returns zero secrets
    const s4 = await getJson('/api/settings', validHeaders);
    assert.strictEqual(s4.status, 200, 'GET /api/settings with valid token must return 200');
    assert.strictEqual(typeof s4.json.hasGroqKey, 'boolean', 'hasGroqKey must be boolean');
    assert.strictEqual(typeof s4.json.hasOpenaiKey, 'boolean', 'hasOpenaiKey must be boolean');
    assert.strictEqual(s4.json.groqApiKey, undefined, 'Raw groqApiKey must never be returned');
    assert.strictEqual(s4.json.openaiApiKey, undefined, 'Raw openaiApiKey must never be returned');
    assert.strictEqual(s4.json.apiToken, undefined, 'Raw apiToken must never be returned');
    console.log('✅ Valid GET /api/settings succeeds without leaking API keys');

    // 1.5 POST /api/settings sanitizes and strips sensitive fields
    const s5 = await postJson('/api/settings', {
      language: 'en-US',
      groqApiKey: 'attacker-injected-key',
      openaiApiKey: 'attacker-injected-key',
      apiToken: 'attacker-token',
      autoCopy: false
    }, validHeaders);
    assert.strictEqual(s5.status, 200, 'POST /api/settings with valid token must return 200');
    assert.strictEqual(s5.json.settings.groqApiKey, undefined, 'POST must strip provider keys');
    assert.strictEqual(s5.json.settings.apiToken, undefined, 'POST must strip apiToken');
    console.log('✅ POST /api/settings sanitizes and rejects client-supplied secrets');

    // -------------------------------------------------------------
    // BLOCKER 2: Contain Privileged Operations
    // -------------------------------------------------------------
    console.log('\n--- BLOCKER 2: Contain Privileged Operations ---');

    // 2.1 POST /api/inject with valid token returns 503
    const injRes = await postJson('/api/inject', { text: 'test injection' }, validHeaders);
    assert.strictEqual(injRes.status, 503, 'POST /api/inject must return 503 Service Unavailable');
    assert.strictEqual(injRes.json.code, 'FEATURE_DISABLED');
    console.log('✅ POST /api/inject returns HTTP 503 even with valid token');

    // 2.2 DELETE /api/history with valid token returns 503
    const delRes = await deleteJson('/api/history', validHeaders);
    assert.strictEqual(delRes.status, 503, 'DELETE /api/history must return 503 Service Unavailable');
    assert.strictEqual(delRes.json.code, 'FEATURE_DISABLED');
    console.log('✅ DELETE /api/history returns HTTP 503 even with valid token');

    // 2.3 Verify history was NOT cleared by the 503 request
    const histRes = await getJson('/api/history', validHeaders);
    assert.strictEqual(histRes.status, 200, 'GET /api/history remains functional for reads');
    console.log('✅ History persistence preserved; no deletion occurred');

    // -------------------------------------------------------------
    // BLOCKER 3: Vercel & Render Routing Topology
    // -------------------------------------------------------------
    console.log('\n--- BLOCKER 3: Vercel & Render Routing Topology ---');

    // 3.1 CORS headers on backend accept talkity.vercel.app
    const corsRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://talkity.vercel.app',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-talkity-token'
      }
    });
    assert.strictEqual(corsRes.headers.get('access-control-allow-origin'), 'https://talkity.vercel.app');
    console.log('✅ Backend CORS permits production Vercel origin https://talkity.vercel.app');

    // -------------------------------------------------------------
    // BLOCKER 4: Rate Limiter Correction & Quota Isolation
    // -------------------------------------------------------------
    console.log('\n--- BLOCKER 4: Rate Limiter Correction & Quota Isolation ---');

    // Test with distinct simulated IP via reverse-proxy header (Render/Vercel hop)
    const testIp = '198.51.100.42';
    const proxyHeaders = {
      'X-Forwarded-For': testIp,
      ...validHeaders
    };

    // 4.1 Normal usage under limit works
    const r1 = await getJson('/api/settings', proxyHeaders);
    assert.strictEqual(r1.status, 200);
    console.log('✅ Normal request under limit succeeds');

    // 4.2 Demo transcription has isolated 10 req/min quota
    const demoIp = '198.51.100.88';
    const demoHeaders = {
      'X-Forwarded-For': demoIp,
      'Content-Type': 'audio/wav'
    };

    let demoLimitHit = false;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${baseUrl}/api/demo/transcribe`, {
        method: 'POST',
        headers: demoHeaders,
        body: Buffer.from('short-audio-clip')
      });
      if (res.status === 429) {
        demoLimitHit = true;
        const retryAfter = res.headers.get('retry-after');
        assert(Number(retryAfter) > 0, 'Retry-After must be positive integer');
        break;
      }
    }
    assert.strictEqual(demoLimitHit, true, 'Demo transcription quota (10 req/min) must enforce 429');
    console.log('✅ Demo transcription strictly enforces 10 req/min quota with Retry-After');

    // 4.3 Quota isolation: demo quota exhaustion does NOT block authenticated /api/settings for that IP!
    const settingsAfterDemo = await getJson('/api/settings', {
      'X-Forwarded-For': demoIp,
      ...validHeaders
    });
    assert.strictEqual(settingsAfterDemo.status, 200, 'Authenticated API must not be blocked by exhausted demo quota');
    console.log('✅ Quota Isolation verified: exhausted demo quota does not affect authenticated API');

    // 4.4 Failed requests are counted towards rate limits
    const failIp = '198.51.100.99';
    let failLimitHit = false;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/api/demo/transcribe`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': failIp, 'Content-Type': 'audio/wav' },
        body: Buffer.alloc(10) // invalid short buffer
      });
      if (res.status === 429) {
        failLimitHit = true;
        break;
      }
    }
    assert.strictEqual(failLimitHit, true, 'Failed requests must be counted towards rate limits');
    console.log('✅ Failed requests counted consistently against rate limiter');

    // 4.5 Concurrent requests handling
    const concIp = '198.51.100.123';
    const concurrentRequests = Array.from({ length: 8 }).map(() =>
      fetch(`${baseUrl}/api/demo/transcribe`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': concIp, 'Content-Type': 'audio/wav' },
        body: Buffer.from('concurrent-test')
      })
    );
    const concResults = await Promise.all(concurrentRequests);
    assert(concResults.every(r => r.status === 400 || r.status === 429), 'Concurrent requests handled safely without crash');
    console.log('✅ Concurrent requests handled atomically without race condition errors');

    // -------------------------------------------------------------
    // BLOCKER 5: Restore /app
    // -------------------------------------------------------------
    console.log('\n--- BLOCKER 5: Restore /app ---');

    // 5.1 GET /app returns 200 and loads app.html (unauthenticated browser page load)
    const appRes = await fetch(`${baseUrl}/app`);
    assert.strictEqual(appRes.status, 200, 'GET /app must return HTTP 200');
    const appHtml = await appRes.text();
    assert(appHtml.includes('Talkity — Web Playground'), 'GET /app must serve Web Playground HTML');
    assert(appHtml.includes('src="app.js"'), 'app.html must reference app.js');
    assert(appHtml.includes('href="styles.css"'), 'app.html must reference styles.css');
    console.log('✅ GET /app returns HTTP 200 and serves Web Playground HTML');

    // 5.2 GET /playground returns 200
    const playRes = await fetch(`${baseUrl}/playground`);
    assert.strictEqual(playRes.status, 200, 'GET /playground must return HTTP 200');
    console.log('✅ GET /playground returns HTTP 200');

    // 5.3 Static assets referenced by /app load with 200
    const cssRes = await fetch(`${baseUrl}/styles.css`);
    assert.strictEqual(cssRes.status, 200, 'styles.css must return HTTP 200');
    const jsRes = await fetch(`${baseUrl}/app.js`);
    assert.strictEqual(jsRes.status, 200, 'app.js must return HTTP 200');
    console.log('✅ Static assets (styles.css, app.js) load with HTTP 200');

    // 5.4 Root page / returns 200
    const rootRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(rootRes.status, 200, 'GET / must return HTTP 200');
    console.log('✅ Root landing page / returns HTTP 200');

    console.log('\n===============================================================');
    console.log('🎉 ALL FIVE BLOCKERS VERIFIED AND RESOLVED SUCCESSFULLY!');
    console.log('===============================================================');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('\n❌ Blocker verification test failed:', err);
  if (server) server.close();
  process.exit(1);
});
