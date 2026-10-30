// Server-side transcription tests.
//
// The Groq call is mocked: these tests verify the exact multipart fields the
// server sends (model, temperature, response_format, optional language/prompt)
// and the meaning-preserving normalizedText response. No API key or network
// access to Groq is used.

const assert = require('assert');

// Provider keys are now resolved server-side only (B2 security remediation):
// the test sets a fake key via the environment, never via client headers. The
// Groq call itself is mocked, so no real key or network access is used.
process.env.GROQ_API_KEY = 'test-groq-key';
const app = require('./server');
const realFetch = global.fetch;

function makeWav(seconds) {
  const sampleRate = 16000;
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function mockGroq(responseText) {
  const captured = { forms: [] };
  global.fetch = async (url, options) => {
    if (String(url).includes('api.groq.com')) {
      captured.forms.push(options.body);
      return {
        ok: true,
        json: async () => ({
          text: responseText,
          language: 'en',
          duration: 1.0,
          segments: [
            { avg_logprob: -0.12, no_speech_prob: 0.01, compression_ratio: 1.4 }
          ]
        })
      };
    }
    return realFetch(url, options);
  };
  return captured;
}

async function postTranscribe(baseUrl, wav, headers) {
  const response = await realFetch(baseUrl + '/api/transcribe', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'audio/wav' }, headers || {}),
    body: wav
  });
  const json = await response.json();
  return { status: response.status, json };
}

function testHelpers() {
  const format = app.locals.formatTranscriptText;
  assert.strictEqual(format('hello world'), 'Hello world.');
  assert.strictEqual(format('hello ,world'), 'Hello, world.');
  assert.strictEqual(
    format('um, i think, you know, we should ship this today'),
    'Um, I think, you know, we should ship this today.'
  );
  assert.strictEqual(format('i\'m ready'), 'I\'m ready.');
  assert.strictEqual(format('i.e. this is fine'), 'I.e. this is fine.');
  assert.strictEqual(format('the meeting is at 3:30 p.m.'), 'The meeting is at 3:30 p.m.');
  assert.strictEqual(format('he said "hello"'), 'He said "hello"');
  assert.strictEqual(format('line one\n\n\nline two'), 'Line one\n\nLine two.');
  assert.strictEqual(format(''), '');
  assert.strictEqual(format(format('um, i think we should ship this today')), format('um, i think we should ship this today'));

  // Filler removal is opt-in: "clean" preserves every word, only "concise" deletes.
  const polish = app.locals.ruleBasedPolish;
  assert.strictEqual(
    polish('um, i think, you know, we should ship this today', 'clean'),
    'Um, i think, you know, we should ship this today.'
  );
  assert.strictEqual(
    polish('um, i think, you know, we should ship this today', 'concise'),
    'I think, we should ship this today.'
  );

  // Dictionary spelling is applied without deleting anything.
  assert.strictEqual(
    format('piyush uses ui automation', [{ phrase: 'pi yush', replacement: 'Piyush' }, { phrase: 'ui automation', replacement: 'UI Automation' }]),
    'Piyush uses UI Automation.'
  );

  assert.strictEqual(app.locals.normalizeWhisperLanguage('EN'), 'en');
  assert.strictEqual(app.locals.normalizeWhisperLanguage('en-IN'), null);
  assert.strictEqual(app.locals.normalizeWhisperLanguage('xx'), null);
  assert.strictEqual(app.locals.normalizeWhisperLanguage('auto'), null);

  const prompt = app.locals.buildVocabularyPrompt([
    { phrase: 'talkity', replacement: 'Talkity' },
    { phrase: 'talkity', replacement: 'Talkity' },
    { phrase: 'pi yush', replacement: 'Piyush' },
    { phrase: '', replacement: '' }
  ]);
  assert.strictEqual(prompt, 'Vocabulary: Talkity, Piyush.');

  assert.strictEqual(app.locals.wavDurationSeconds(makeWav(1.5)), 1.5);
  assert.strictEqual(app.locals.wavDurationSeconds(Buffer.alloc(10)), 0);

  console.log('✅ Helper and formatter tests passed.');
}

async function testTranscribe() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  try {
    // 1. Default request: auto language, vocabulary prompt, verbose metadata.
    let captured = mockGroq('Um, I think, you know, we should ship this today');
    let result = await postTranscribe(baseUrl, makeWav(1.5), {});
    assert.strictEqual(result.status, 200);
    assert.strictEqual(captured.forms.length, 1);
    let form = captured.forms[0];
    assert.strictEqual(form.get('model'), 'whisper-large-v3');
    assert.strictEqual(form.get('temperature'), '0');
    assert.strictEqual(form.get('response_format'), 'verbose_json');
    assert.strictEqual(form.get('language'), null, 'language omitted for auto-detect');
    // The prompt is derived from the user's saved dictionary, so assert its
    // shape and deduplication instead of hard-coding user data.
    const prompt = form.get('prompt');
    assert.ok(prompt && prompt.indexOf('Vocabulary: ') === 0, 'vocabulary prompt is sent');
    assert.ok(prompt.indexOf('Talkity') !== -1, 'dictionary term is included');
    const promptTerms = prompt.replace(/^Vocabulary: /, '').replace(/\.$/, '').split(', ');
    assert.strictEqual(promptTerms.length, new Set(promptTerms.map(t => t.toLowerCase())).size, 'prompt terms are deduplicated');
    assert.strictEqual(result.json.text, 'Um, I think, you know, we should ship this today');
    assert.strictEqual(result.json.normalizedText, 'Um, I think, you know, we should ship this today.');
    assert.strictEqual(result.json.formattedText, 'Um, I think, you know, we should ship this today.', 'legacy clean output preserves every spoken word');
    assert.strictEqual(result.json.language, 'en');
    assert.strictEqual(result.json.provider, 'groq-whisper-large-v3');
    console.log('✅ Default transcription request passed.');

    // 2. Explicit language is forwarded only when valid.
    captured = mockGroq('Hello world');
    result = await postTranscribe(baseUrl, makeWav(1.0), { 'x-language': 'hi' });
    assert.strictEqual(captured.forms[0].get('language'), 'hi');
    assert.strictEqual(result.status, 200);

    captured = mockGroq('Hello world');
    result = await postTranscribe(baseUrl, makeWav(1.0), { 'x-language': 'en-IN' });
    assert.strictEqual(captured.forms[0].get('language'), null, 'region locale is not sent');
    assert.strictEqual(result.status, 200);

    captured = mockGroq('Hello world');
    result = await postTranscribe(baseUrl, makeWav(1.0), { 'x-language': 'xx' });
    assert.strictEqual(captured.forms[0].get('language'), null, 'unknown code is not sent');
    assert.strictEqual(result.status, 200);
    console.log('✅ Explicit/auto language handling passed.');

    // 3. Very short clips do not get a vocabulary prompt (leak risk).
    captured = mockGroq('Hi');
    result = await postTranscribe(baseUrl, makeWav(0.2), {});
    assert.strictEqual(captured.forms[0].get('prompt'), null, 'no prompt for short clips');
    assert.strictEqual(result.status, 200);
    console.log('✅ Short-clip prompt suppression passed.');

    // 4. Response format is still a superset of the old JSON contract.
    captured = mockGroq('The quick brown fox jumps over the lazy dog.');
    result = await postTranscribe(baseUrl, makeWav(1.5), {});
    assert.strictEqual(result.json.text, 'The quick brown fox jumps over the lazy dog.');
    assert.strictEqual(result.json.normalizedText, 'The quick brown fox jumps over the lazy dog.');
    assert.strictEqual(result.json.formattedText, 'The quick brown fox jumps over the lazy dog.');
    console.log('✅ Backward-compatible response fields passed.');
  } finally {
    global.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  testHelpers();
  await testTranscribe();
  console.log('🎉 All server transcription tests passed.');
  process.exitCode = 0;
})().catch((error) => {
  console.error('❌ Server transcription tests failed:', error);
  process.exitCode = 1;
});
