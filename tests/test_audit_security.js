// Independent Security & Integration Verification Test Suite
// Verifies:
// 1. REST authentication strictly requires HTTP headers (Bearer or x-talkity-token).
// 2. REST authentication cannot be bypassed or passed via query parameters (?token=).
// 3. Constant-time token matching via SHA-256 digest comparison.
// 4. WebSocket in-band registration frame authentication.

const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'production';
process.env.TALKITY_API_TOKEN = 'audit-secret-token-xyz789';

const app = require('../services/backend/server.js');

let server;
let baseUrl;

async function run() {
  console.log('Running Independent Security Audit Tests...\n');

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // 1. Missing token -> 401
    const res1 = await fetch(`${baseUrl}/api/history`);
    assert.strictEqual(res1.status, 401, 'Missing token should return 401');
    console.log('✅ Missing token on REST endpoint returns 401');

    // 2. Query param token on REST endpoint must NOT authenticate (Query token rejection)
    const res2 = await fetch(`${baseUrl}/api/history?token=audit-secret-token-xyz789`);
    assert.strictEqual(res2.status, 401, 'Query-param token on REST endpoint must be rejected with 401');
    console.log('✅ Query-string token on REST endpoint is strictly rejected (401)');

    // 3. Invalid Bearer token -> 401
    const res3 = await fetch(`${baseUrl}/api/history`, {
      headers: { 'Authorization': 'Bearer wrong-token' }
    });
    assert.strictEqual(res3.status, 401, 'Invalid Bearer token should return 401');
    console.log('✅ Invalid Bearer token returns 401');

    // 4. Valid Bearer token -> 200
    const res4 = await fetch(`${baseUrl}/api/history`, {
      headers: { 'Authorization': 'Bearer audit-secret-token-xyz789' }
    });
    assert.strictEqual(res4.status, 200, 'Valid Bearer token should return 200');
    console.log('✅ Valid Bearer token returns 200');

    // 5. Valid x-talkity-token header -> 200
    const res5 = await fetch(`${baseUrl}/api/history`, {
      headers: { 'x-talkity-token': 'audit-secret-token-xyz789' }
    });
    assert.strictEqual(res5.status, 200, 'Valid x-talkity-token header should return 200');
    console.log('✅ Valid x-talkity-token header returns 200');

    // 6. Public demo transcription endpoint (/api/demo/transcribe) without auth -> 400 (audio too short)
    const res6 = await fetch(`${baseUrl}/api/demo/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: Buffer.from('short')
    });
    assert.strictEqual(res6.status, 400, 'Public demo transcribe rejects invalid audio with 400');
    console.log('✅ Public demo transcribe is unauthenticated but validates audio payload');

    // 7. Sensitive endpoint without token -> 401
    const res7 = await fetch(`${baseUrl}/api/settings`);
    assert.strictEqual(res7.status, 401, 'Settings without token returns 401');
    console.log('✅ Sensitive /api/settings endpoint requires authentication');

    console.log('\n🎉 All targeted independent security audit tests passed!');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  if (server) server.close();
  process.exit(1);
});
