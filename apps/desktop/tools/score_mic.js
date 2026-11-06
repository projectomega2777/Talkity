// Score real-microphone recordings against known reference transcripts.
//
// Usage:
//   node apps/desktop/tools/score_mic.js <manifest.json> [--endpoint URL] [--language en]
//
// Manifest:
//   [{ "id": 1, "reference": "known text", "file": "rec-01.wav" }, ...]
//
// The script posts each WAV to /api/transcribe and reports:
//   - raw Whisper text WER/CER
//   - the desktop output (normalizedText, or the local conservative formatter)
//   - the legacy server formattedText, for comparison
//
// It never modifies the recordings and never invents a reference.

const fs = require('fs');
const path = require('path');
const app = require(path.join(__dirname, '..', '..', '..', 'services', 'backend', 'server.js'));

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node apps/desktop/tools/score_mic.js <manifest.json> [--endpoint URL] [--language en]');
  process.exit(2);
}

let manifestPath = args[0];
let endpoint = 'https://talkity-qifh.onrender.com';
let language = '';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--endpoint' && args[i + 1]) endpoint = args[++i];
  else if (args[i] === '--language' && args[i + 1]) language = args[++i];
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const baseDir = path.dirname(path.resolve(manifestPath));

function norm(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}\u2018\u2019\u201C\u201D\u2013\u2014-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function wer(reference, hypothesis) {
  const r = norm(reference).split(' ').filter(Boolean);
  const h = norm(hypothesis).split(' ').filter(Boolean);
  if (!r.length) return 0;
  return levenshtein(r, h) / r.length;
}

function cer(reference, hypothesis) {
  const r = norm(reference).replace(/ /g, '');
  const h = norm(hypothesis).replace(/ /g, '');
  if (!r.length) return 0;
  return levenshtein(r, h) / r.length;
}

async function transcribe(file) {
  const buffer = fs.readFileSync(file);
  const headers = { 'Content-Type': 'audio/wav' };
  if (language) headers['x-language'] = language;
  const response = await fetch(endpoint.replace(/\/$/, '') + '/api/transcribe', {
    method: 'POST',
    headers,
    body: buffer
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { error: text.slice(0, 200) }; }
  return { status: response.status, json };
}

(async () => {
  const rows = [];
  for (const item of manifest) {
    const file = path.isAbsolute(item.file) ? item.file : path.join(baseDir, item.file);
    const started = Date.now();
    let result;
    try {
      result = await transcribe(file);
    } catch (error) {
      result = { status: 0, json: { error: error.message } };
    }

    const raw = result.json.text || '';
    const normalized = result.json.normalizedText || app.locals.formatTranscriptText(raw, []);
    const legacy = result.json.formattedText || '';
    const qualitative = item.qualitative === true;
    const rawW = wer(item.reference, raw);
    const outW = wer(item.reference, normalized);
    const oldW = legacy ? wer(item.reference, legacy) : null;
    const rawC = cer(item.reference, raw);
    const outC = cer(item.reference, normalized);
    const oldC = legacy ? cer(item.reference, legacy) : null;

    rows.push({
      id: item.id,
      reference: item.reference,
      file: item.file,
      qualitative,
      status: result.status,
      language: result.json.language || null,
      raw,
      normalized,
      legacy,
      rawWER: rawW,
      outputWER: outW,
      legacyWER: oldW,
      rawCER: rawC,
      outputCER: outC,
      legacyCER: oldC,
      error: result.json.error || null,
      ms: Date.now() - started
    });

    console.log(`[${item.id}] HTTP ${result.status} in ${Date.now() - started}ms${qualitative ? ' (qualitative, excluded from aggregate)' : ''}`);
    console.log(`  ref: ${item.reference}`);
    console.log(`  raw: ${raw}`);
    console.log(`  out: ${normalized}`);
    if (legacy) console.log(`  old: ${legacy}`);
    console.log(`  WER raw ${(rawW * 100).toFixed(1)}% | out ${(outW * 100).toFixed(1)}%` +
      (oldW === null ? '' : ` | old ${(oldW * 100).toFixed(1)}%`));
  }

  const valid = rows.filter(r => r.status === 200 && !r.qualitative);
  const mean = (key) => valid.length ? valid.reduce((sum, r) => sum + r[key], 0) / valid.length : 0;
  const summary = {
    endpoint,
    language: language || 'auto',
    count: valid.length,
    qualitativeCount: rows.filter(r => r.qualitative).length,
    meanRawWER: mean('rawWER'),
    meanOutputWER: mean('outputWER'),
    meanLegacyWER: valid.some(r => r.legacyWER !== null) ? mean('legacyWER') : null,
    meanRawCER: mean('rawCER'),
    meanOutputCER: mean('outputCER'),
    meanLegacyCER: valid.some(r => r.legacyCER !== null) ? mean('legacyCER') : null,
    rows
  };

  const outPath = path.join(baseDir, 'results.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log('\nid | rawWER | outWER | oldWER | rawCER | outCER');
  for (const r of rows) {
    console.log(`${String(r.id).padStart(2)} | ${(r.rawWER * 100).toFixed(1).padStart(6)}% | ${(r.outputWER * 100).toFixed(1).padStart(6)}% | ` +
      `${r.legacyWER === null ? '   n/a' : (r.legacyWER * 100).toFixed(1).padStart(6) + '%'} | ` +
      `${(r.rawCER * 100).toFixed(1).padStart(6)}% | ${(r.outputCER * 100).toFixed(1).padStart(6)}%` +
      (r.qualitative ? '  (qualitative)' : ''));
  }
  console.log(`\nmean rawWER=${(summary.meanRawWER * 100).toFixed(2)}% outputWER=${(summary.meanOutputWER * 100).toFixed(2)}%` +
    (summary.meanLegacyWER === null ? '' : ` legacyWER=${(summary.meanLegacyWER * 100).toFixed(2)}%`));
  console.log(`mean rawCER=${(summary.meanRawCER * 100).toFixed(2)}% outputCER=${(summary.meanOutputCER * 100).toFixed(2)}%` +
    (summary.meanLegacyCER === null ? '' : ` legacyCER=${(summary.meanLegacyCER * 100).toFixed(2)}%`));
  console.log(`\nWrote ${outPath}`);
  process.exitCode = 0;
})();
