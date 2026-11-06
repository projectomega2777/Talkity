// Score real-microphone dictations from Talkity's own history against a known
// reference corpus.
//
// Usage:
//   node desktop/tools/score_history.js --corpus desktop/tools/mic_corpus_en.json --since <epoch-ms>
//   node desktop/tools/score_history.js --corpus ... --since ... --history <path>
//
// This measures what the user actually sees. It separates:
//   - recognition errors : word-level substitutions/deletions/insertions (WER)
//   - formatting errors  : casing and punctuation differences with identical words
//   - enhancement errors : server-side /api/polish rewrites (entries with enhanced=true)
//
// Entries flagged "duplicate" in the corpus are reported but excluded from the
// aggregate so one reference cannot be weighted twice.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { corpus: null, since: 0, history: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') out.corpus = argv[++i];
    else if (argv[i] === '--since') out.since = Number(argv[++i]);
    else if (argv[i] === '--history') out.history = argv[++i];
  }
  return out;
}

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Token normalization. Two artifacts have to be removed or WER is inflated by
// spelling choices rather than recognition:
//   "anti-gravity" vs "Antigravity"  -> a hyphen must not split one word in two
//   "3:30" / "3.30", "p.m." / "pm"   -> intra-word separators must not split
// Everything else is punctuation and becomes a token boundary.
function stripPunct(s) {
  let t = collapse(s);
  // Join punctuation that sits between two alphanumerics (times, decimals,
  // initials, abbreviations) so it never creates a fake token boundary.
  for (let i = 0; i < 4; i++) t = t.replace(/([A-Za-z0-9])[.:]([A-Za-z0-9])/g, '$1$2');
  t = t.replace(/([A-Za-z])-([A-Za-z])/g, '$1$2');
  t = t.replace(/[.,!?;:'"`()\[\]{}\u2018\u2019\u201C\u201D\u2013\u2014-]/g, ' ');
  return collapse(t);
}

const words = (s) => stripPunct(s).toLowerCase().split(' ').filter(Boolean);
const letters = (s) => stripPunct(s).toLowerCase().replace(/ /g, '');

// Levenshtein with backtrace so we can report substitutions/deletions/insertions.
function align(ref, hyp) {
  const m = ref.length, n = hyp.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && dp[i][j] === dp[i - 1][j - 1]) { i--; j--; continue; }
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ op: 'S', ref: ref[i - 1], hyp: hyp[j - 1] }); i--; j--; continue;
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { ops.push({ op: 'D', ref: ref[i - 1] }); i--; continue; }
    ops.push({ op: 'I', hyp: hyp[j - 1] }); j--;
  }
  ops.reverse();
  const distance = dp[m][n];
  return {
    distance,
    substitutions: ops.filter(o => o.op === 'S').length,
    deletions: ops.filter(o => o.op === 'D').length,
    insertions: ops.filter(o => o.op === 'I').length,
    ops: ops.filter(o => o.op !== 'I' || true)
  };
}

function classify(ref, hyp) {
  const a = collapse(ref), b = collapse(hyp);
  if (a === b) return 'exact';
  if (a.toLowerCase() === b.toLowerCase()) return 'case-only';
  if (stripPunct(a) === stripPunct(b)) return 'punctuation-only';
  if (stripPunct(a).toLowerCase() === stripPunct(b).toLowerCase()) return 'case+punctuation';
  return 'word-difference';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.corpus) {
    console.error('Usage: node desktop/tools/score_history.js --corpus <file> --since <epoch-ms> [--history <path>]');
    process.exit(2);
  }

  const historyPath = args.history || path.join(process.env.APPDATA || '', 'Talkity', 'history.json');
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8').replace(/^\uFEFF/, ''));
  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8').replace(/^\uFEFF/, ''));

  const fresh = history
    .filter(e => e.timestamp > args.since)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, corpus.length);

  if (fresh.length < corpus.length) {
    console.error(`Only ${fresh.length} new history entries but corpus has ${corpus.length}.`);
    process.exit(3);
  }

  const rows = [];
  for (let k = 0; k < corpus.length; k++) {
    const ref = corpus[k];
    const entry = fresh[k];
    const refWords = words(ref.reference);
    const hypWords = words(entry.text);
    const wordAlign = align(refWords, hypWords);
    const charAlign = align(letters(ref.reference).split(''), letters(entry.text).split(''));

    rows.push({
      id: ref.id,
      duplicate: ref.duplicate === true,
      exclude: ref.exclude === true,
      note: ref.note || '',
      reference: ref.reference,
      hypothesis: entry.text,
      enhanced: entry.enhanced === true,
      inserted: entry.inserted === true,
      targetApp: entry.targetApp || '',
      timestamp: entry.timestamp,
      time: new Date(entry.timestamp).toLocaleTimeString(),
      refWordCount: refWords.length,
      wer: refWords.length ? wordAlign.distance / refWords.length : 0,
      cer: letters(ref.reference).length ? charAlign.distance / letters(ref.reference).length : 0,
      substitutions: wordAlign.substitutions,
      deletions: wordAlign.deletions,
      insertions: wordAlign.insertions,
      diffKind: classify(ref.reference, entry.text),
      ops: wordAlign.ops
    });
  }

  const fmtPct = (v) => (v * 100).toFixed(2).padStart(6) + '%';
  const mean = (arr, key) => (arr.length ? arr.reduce((s, r) => s + r[key], 0) / arr.length : 0);

  console.log('\n=== Per-dictation ===\n');
  for (const r of rows) {
    const tags = [];
    if (r.duplicate) tags.push('DUPLICATE');
    if (r.exclude) tags.push('EXCLUDED');
    if (r.enhanced) tags.push('ENHANCED');
    if (r.inserted) tags.push('INSERTED->' + r.targetApp);
    console.log(`[${r.id}] ${r.time}${tags.length ? '  (' + tags.join(', ') + ')' : ''}`);
    if (r.note) console.log(`  note: ${r.note}`);
    console.log(`  ref : ${r.reference}`);
    console.log(`  got : ${r.hypothesis}`);
    console.log(`  WER ${fmtPct(r.wer)}  CER ${fmtPct(r.cer)}  S=${r.substitutions} D=${r.deletions} I=${r.insertions}  diff=${r.diffKind}`);
    if (r.ops.length) {
      console.log('  ops : ' + r.ops.map(o =>
        o.op === 'S' ? `S[${o.ref}->${o.hyp}]` : o.op === 'D' ? `D[${o.ref}]` : `I[${o.hyp}]`).join(' '));
    }
    console.log('');
  }

  const primary = rows.filter(r => !r.duplicate && !r.exclude);
  const rawOnly = primary.filter(r => !r.enhanced);
  const enhanced = primary.filter(r => r.enhanced);
  const excluded = rows.filter(r => r.exclude && !r.duplicate);

  const summarize = (label, set) => {
    if (!set.length) { console.log(`${label}: no samples`); return; }
    console.log(`${label} (n=${set.length})`);
    console.log(`  mean WER ${fmtPct(mean(set, 'wer'))}   mean CER ${fmtPct(mean(set, 'cer'))}`);
    console.log(`  total word errors: S=${set.reduce((s, r) => s + r.substitutions, 0)} ` +
      `D=${set.reduce((s, r) => s + r.deletions, 0)} I=${set.reduce((s, r) => s + r.insertions, 0)}`);
    const kinds = {};
    for (const r of set) kinds[r.diffKind] = (kinds[r.diffKind] || 0) + 1;
    console.log(`  diff kinds: ${Object.entries(kinds).map(([k, v]) => k + '=' + v).join(', ')}`);
    const perfect = set.filter(r => r.wer === 0).length;
    console.log(`  exact word match: ${perfect}/${set.length} (${((perfect / set.length) * 100).toFixed(1)}%)`);
  };

  console.log('\n=== Aggregate ===\n');
  summarize('All primary samples', primary);
  console.log('');
  summarize('Raw Whisper (enhanced=false)', rawOnly);
  console.log('');
  summarize('Enhanced by /api/polish (enhanced=true)', enhanced);

  if (excluded.length) {
    console.log('');
    console.log(`Excluded from aggregate (unverifiable reference) (n=${excluded.length})`);
    for (const r of excluded) {
      console.log(`  [${r.id}] WER ${fmtPct(r.wer)}  ${r.note}`);
    }
  }

  const outPath = path.join(path.dirname(path.resolve(args.corpus)), 'history_results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    historyPath,
    since: args.since,
    corpus: path.resolve(args.corpus),
    aggregate: {
      primary: { n: primary.length, meanWER: mean(primary, 'wer'), meanCER: mean(primary, 'cer') },
      rawOnly: { n: rawOnly.length, meanWER: mean(rawOnly, 'wer'), meanCER: mean(rawOnly, 'cer') },
      enhanced: { n: enhanced.length, meanWER: mean(enhanced, 'wer'), meanCER: mean(enhanced, 'cer') }
    },
    rows
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
