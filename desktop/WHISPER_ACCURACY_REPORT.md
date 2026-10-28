# Whisper Transcription Accuracy Report

Date: 2026-10-28
Engine: Groq `whisper-large-v3` (unchanged)
Scope: desktop capture → `/api/transcribe` → transcript shown/inserted

## Summary

Real-microphone accuracy was measured for the first time, using ten English
dictations with known reference text plus one Hindi-English sample.

| Measurement | Mean WER | Mean CER |
| --- | ---: | ---: |
| **Raw Whisper, real microphone** (n=10) | **11.41%** | **4.88%** |
| Raw Whisper, corpus-weighted | **10.20%** | — |
| As shipped, enhancement on (n=10) | 13.41% | 7.93% |
| Synthetic TTS baseline (n=9, earlier run) | 13.69% | 5.15% |
| Synthetic TTS, paired before/after deploy (n=9) | 12.46% → **11.22%** | 5.36% → 5.62% |

Real-microphone accuracy is **not worse than the synthetic baseline** despite
room noise and Bluetooth capture. The largest measured error source is not
acoustics: it is **proper-noun recognition** (`Piyush` failed 4 of 4 times) and
the **server-side polish step**, which rewrote the speaker's actual words on the
dictations where it fired.

## Post-deploy verification (2026-10-28)

The updated server is now in production. `origin/main` moved from `9d2fc37` to
`23de492` (server, dictionary, and server test only), and the deployment is
confirmed by production responses rather than by the push alone.

| Check | Before deploy | After deploy |
| --- | --- | --- |
| `/api/transcribe` fields | `text`, `formattedText`, `provider` | adds `normalizedText`, `language` |
| `x-language: auto` | no effect | `language: "English"` |
| `x-language: en` | no effect | `language: "English"` |
| `x-language: hi` (English audio) | identical to `en` | `language: "Hindi"` |
| `x-language: en-US` (invalid) | ignored | ignored, falls back to auto |
| `/api/dictionary` | no `piyush` rule | `piyush → Piyush`, `talkity → Talkity` |
| `/api/polish` `clean` | `"I think, we should ship this today."` | `"Um, I think, you know, we should ship this today."` |
| `/api/polish` `concise` | fillers removed | fillers removed (opt-in, unchanged) |

The vocabulary prompt built from the production dictionary is:

```
Vocabulary: Wispr Flow, Talkity, Piyush, Antigravity, REA, UI Automation.
```

### Paired synthetic corpus, before vs after

The same nine TTS WAVs were posted before and after the deploy, scored with the
same normalizer. Before the deploy the client had no `normalizedText` to read, so
the user-visible text was raw Whisper plus the local formatter; after, it is the
server's `normalizedText`.

| # | Reference | Before WER | After WER | Change |
| --- | --- | ---: | ---: | --- |
| 1–4 | fox / hello / please / Talkity | 0.0% | 0.0% | — |
| 5 | Piyush, Antigravity, UI Automation | 11.1% | **0.0%** | dictionary joins `anti-gravity`, fixes casing |
| 6 | numbers one…five | 55.6% | 55.6% | unchanged (Whisper emits digits) |
| 7 | Um, I think, you know | 0.0% | 0.0% | unchanged (fillers now preserved) |
| 8 | Whisper Large V3 | 0.0% | **9.1%** | **regression: "WISPR LARGE V3"** |
| 9 | 3:30 p.m. Room 204 | 45.5% | **36.4%** | `3.30 PM` scores closer than `3.30pm` |
| | **Mean** | **12.46%** | **11.22%** | −1.24 points |

Row 8 is a real side effect of the vocabulary prompt, not noise: five
consecutive post-deploy requests returned `WISPR LARGE V3`, and the only
difference in the Whisper request is the added prompt, which contains
`Wispr Flow`. It is acoustically adjacent to "Whisper" and the decoder follows
it. Removing or renaming that one dictionary entry is the fix; it was left in
place because it is the user's brand vocabulary, not a defect in the code.

### Proper-name accuracy on the synthetic corpus

`Piyush` and `Talkity` were already recognised exactly in raw Whisper output on
this corpus, before and after the deploy (3/3 occurrences). The synthetic voice
is too clean to reproduce the real-microphone failures, so **this corpus cannot
demonstrate a vocabulary improvement**; it only proves the mechanism is wired and
reachable in production. The real-microphone re-test is still required.


## What was measured

Two passes, both through the live pipeline (`Talkity.exe` → production
`/api/transcribe` → history), scored against fixed reference sentences read by
one speaker in a normal room on the default input device
(`Headset (Airdopes 131 Hands-Free AG Audio)`).

- **Pass 1** — 11 references, enhancement as configured (`enhanceText: true`).
  Twelve dictations resulted because reference 5 was recorded twice.
- **Pass 2** — the three sentences that enhancement had rewritten, re-dictated
  with `enhanceText: false`, so history text is the local formatter applied to
  raw Whisper with no server rewrite. Plus one Hindi-English sentence.

Audio was healthy throughout: peak −4.8 to 0.0 dBFS, RMS −17.2 to −23.7 dBFS,
clipping 0.00–0.02%, no silent captures. Capture-start latency was 80–276 ms.

Scoring normalizes case and punctuation, joins intra-word separators
(`3:30` = `3.30`, `p.m.` = `pm`) and joins hyphenated compounds
(`anti-gravity` = `Antigravity`), so spelling style is not counted as a
recognition error. Every number below is reproducible with
`desktop/tools/score_history.js`.

## Per-dictation results (raw Whisper, enhancement off)

| # | Reference | Transcript | WER | CER | Errors |
| --- | --- | --- | ---: | ---: | --- |
| 1 | The quick brown fox jumps over the lazy dog. | …fox **jumped** over… | 11.11% | 5.71% | S jumps→jumped |
| 2 | Hello world, how are you today? | exact | 0.00% | 0.00% | — |
| 3 | Please dictate this sentence accurately. | …dictate **the** sentence… | 20.00% | 5.71% | S this→the |
| 4 | Talkity connects to the server for processing. | **Tokity** connects… | 14.29% | 5.13% | S Talkity→Tokity |
| 5 | Piyush is testing Antigravity and UI Automation with Talkity. | **FUSE** is testing anti-gravity and UI automation with **Taukity**. | 22.22% | 9.62% | S Piyush→FUSE, S Talkity→Taukity |
| 7 | Um, I think, you know, we should ship this today. | I think you know we should **skip** this today. | 20.00% | 8.33% | D Um, S ship→skip |
| 8 | I am testing Whisper Large V3 with a known reference text. | …with **unknown** reference text. | 18.18% | 4.26% | D a, S known→unknown |
| 9 | Thanks, let's meet at 3:30 p.m. in Room 204. | Thanks. Let's meet at 3.30 p.m. in room 204. | 0.00% | 0.00% | formatting only |
| 10 | Schedule a meeting with Piyush tomorrow at 3:30 p.m. in Room 204. | …with **Deuce** tomorrow at 3.30 pm in room 204. | 8.33% | 10.00% | S Piyush→Deuce |
| 11 | Hello Talkity, this is a test of Talkity. I am checking whether my voice is converted into accurate text and insert automatically. | exact | 0.00% | 0.00% | — |

**Aggregate (n=10):** 10 word errors over 98 reference words. Mean WER 11.41%,
mean CER 4.88%, corpus-weighted WER 10.20%. Exact word match on 3 of 10
dictations (30%).

Error composition: **8 substitutions, 2 deletions, 0 insertions.** Raw Whisper
never invented a word in this sample. All 10 errors are word-level; the one
formatting deviation (row 9) changed casing and a time separator but no word.

## Recognition error classes, by frequency

| Class | Occurrences | Rate | Example |
| --- | ---: | ---: | --- |
| Proper noun `Piyush` | 4 / 4 | 100% | Vue, Fuse, FUSE, Deuce |
| Brand `Talkity` | 3 / 7 | 43% | Tokity, Taukity, Topity |
| Function/lexical near-miss | 3 / 10 dictations | — | this→the, ship→skip, jumps→jumped |
| Article collapse | 1 / 10 | — | "a known" → "unknown" |
| Filler deletion by Whisper | 1 / 10 | — | "Um" dropped |

`Piyush` and `Talkity` are the dominant, repeatable failures. They are
out-of-vocabulary proper nouns, which is exactly what a vocabulary prompt
addresses — but that prompt is not active in production (see below).

## Enhancement (polish) is adding errors

Four of twelve pass-1 dictations returned `enhanced=true`. Re-dictating the same
sentences with enhancement off gives a paired comparison on identical audio
content and the same speaker:

| Ref | With polish (`enhanced=true`) | Raw Whisper (`enhanced=false`) |
| --- | --- | --- |
| 4 | "**The** Talkity connects…" — 14.29% | "**Tokity** connects…" — 14.29% |
| 5 | "Vue is testing…" — 22.22% | "FUSE is testing…" — 22.22% |
| 7 | "**Let me think**, we should ship this today." — **40.00%** | "I think you know we should **skip** this today." — **20.00%** |
| **Mean** | **25.50%** | **18.84%** |

The polish step inserted a word that was never spoken ("The"), and on row 7 it
replaced "Um, I think, you know" with "Let me think" — a semantic rewrite of the
speaker's words, not a punctuation fix. This is the same defect the desktop
already avoids by refusing the server's `formattedText`; `/api/polish` with tone
`clean` used to carry the identical instruction: *"remove filler words (um, uh,
like)"*. That instruction has since been replaced with a punctuation-only
contract, and the client now rejects any enhancement that changes the words.

Note that the raw pipeline also drops "Um" on its own (row 7, enhancement off).
That is Whisper behaviour and is not caused by polish, so removing polish will
not preserve fillers completely.

## Capture diagnostics

### Microphone level and clipping

Healthy and require no change. Peak −4.8 to 0.0 dBFS, RMS −17.2 to −23.7 dBFS,
clipping at most 0.02%. No gain, trimming, or noise reduction was added and none
is justified by these measurements.

### Tail truncation is device-specific

| Input device | Dictations | Audio vs capture window |
| --- | ---: | --- |
| Airdopes 131 (Bluetooth HFP) | 15 | **0.64 – 1.21 s short** |
| Realtek onboard (wired) | 6 | 0.14 – 0.19 s short |

The 0.14–0.19 s baseline is the fixed stop overhead (`waveInStop` →
`waveInReset` → `Thread.Sleep(100)` → `waveInClose`). The extra **0.3–1.0 s on
the Bluetooth path** was originally attributed to `waveInReset` discarding a
queued buffer. The drain experiment above disproved that: after `waveInStop` the
driver delivers **nothing more**, even when given 200–300 ms before reset, so the
audio never reaches WinMM at all. The recorder's callback copies
`dwBytesRecorded` for partial buffers and keeps copying after stop, which is why
the wired path loses only the fixed stop overhead.

This test deliberately paused ~1 s before pressing F8, which masked the loss.
Without that pause the final word would be cut on the default device. It is a
latent truncation, not an observed word loss in these ten dictations.

### First-word loss: no evidence

No utterance lost its first word. The only leading deletion was "Um", a filler
Whisper drops natively. Leading-silence values are however **unreliable on this
device**: several dictations that ended with a deliberate pause still reported
`tail 0ms`, so the leading/trailing silence metrics cannot be trusted on the
Bluetooth path. Neither start-loss nor tail-loss can be separated with the
current instrumentation.

## Language detection

- **English under `auto`:** detected as English and transcribed correctly in
  English, including the Hinglish test's Latin numerals ("3.30 PM").
- **Hindi-English mixed under `auto`:** detected as Hindi and returned
  **Devanagari script**:

  > आज मैं ओफिस जा रहा हूँ मीटिंग 3.30 PM पर है

  "office" was transliterated as "ओफिस" and the time stayed Latin. This is
  correct auto-detection, but a user expecting romanized Hinglish will not get
  it. It is not scored against a reference because no agreed code-mixed output
  form exists.
- **Explicit language: not exercisable in production.** The deployed server
  ignores `x-language` entirely — sending the same WAV with `x-language=en`,
  `hi`, and `auto` returns byte-identical English — and the response contains
  only `text`, `formattedText`, `provider`, with no `language` field. The
  desktop therefore cannot force a language today.

## Insertion

Automatic insertion is working. All four pass-2 dictations, and the four
follow-up dictations, recorded `inserted=true` against target `OpenCode`. The
twelve pass-1 dictations recorded `inserted=false` only because Talkity itself
was foreground; the log confirms `Hotkey pressed while Talkity was foreground; no
external target captured` and `text placed on clipboard only`, which is the
designed fallback, not a failure.

## Root causes, ranked by measured impact

1. **Production was running the old `/api/transcribe`.** Resolved: `23de492` is
   deployed and returns `normalizedText` and `language`, honours `x-language`,
   and reads the dictionary that now contains `Piyush` and `Talkity`.
2. **The `/api/polish` "clean" step rewrote content.** Resolved at two layers:
   the server no longer removes fillers outside the explicit `concise` tone, and
   the desktop client rejects any enhancement that changes the word sequence.
   Paired measurement of the old behaviour: 18.84% → 25.50% mean WER, with a
   spurious "The" and "I think, you know" → "Let me think".
3. **Bluetooth HFP delivers less audio than wall time.** Measured, not fixed.
   See below; the missing audio is never handed to the application, so no
   client-side drain can recover it.
4. **Whisper's own number/time normalization** (`one two three` → `1, 2, 3`,
   `3:30` → `3.30`). Model behaviour; not safely fixable with punctuation rules
   and not worth a rewrite step.

## Bluetooth tail loss: drain experiment (measured, reverted)

The hypothesis was that `waveInReset` discards buffers still pending at stop.
It was tested in the recorder with the existing harness, in silence, so the
measurement is content-free and does not depend on the headset being worn:

| Capture window | Device | Audio captured | Shortfall |
| --- | --- | --- | ---: |
| 6.2 s | Airdopes HFP | 5.33–5.43 s | 0.77–0.90 s |
| 12.1 s | Airdopes HFP | 10.98 s | 1.16 s |
| 20.1 s | Airdopes HFP | 19.28 s | 0.86 s |
| 12.2 s | Realtek wired | 12.01 s | 0.15 s |
| 20.2 s | Realtek wired | 20.00 s | 0.15 s |

The shortfall is fixed, not proportional, so it is a tail loss rather than a
clock mismatch. Two drains were implemented and measured:

1. **Wait for a `WHDR_DONE` header before reset.** Exits immediately — a
   completed header is always pending — and changed nothing (0.78–0.86 s).
2. **Wait until the driver's data stream goes idle (300 ms quiet, 1500 ms cap).**
   Waited 200 ms and the driver delivered **zero bytes** during the wait; the
   shortfall stayed at 1.10 s versus a 1.16 s baseline, inside run-to-run noise,
   while adding 200 ms of latency to every stop.

Conclusion: the missing audio is lost inside the hands-free stack before it
reaches WinMM. It is not recoverable by draining or by delaying `waveInReset`,
so both experiments were reverted and the recorder is byte-identical to its
previous revision. The existing log warning (`Audio is N ms shorter than the
capture window`) now makes the condition visible in production.

## Recommended fixes

1. ~~Deploy the updated server.~~ Done in `23de492`, verified above.
2. ~~Default `enhanceText` to off, or stop `clean` from removing fillers and
   rewriting phrasing.~~ Done: the default is now `false`, the server gates filler
   removal behind `concise`, and the client rejects word-changing enhancements.
3. **Re-run the real-microphone corpus for the proper nouns.** The synthetic
   corpus cannot show the vocabulary effect; `Piyush` at 4/4 failures needs a
   real-mic re-test with the deployed prompt.
4. **Decide on the `whisper flow → Wispr Flow` entry.** It reproducibly turns
   "Whisper" into "WISPR" (5/5 requests). Removing or renaming it is a one-line
   dictionary change.
5. **Mitigate the Bluetooth shortfall by device choice.** Use a non-HFP capture
   endpoint (wired or USB microphone) where the tail matters. Draining was
   measured and does not help.
6. **Document the Hinglish behaviour.** Auto-detect returns Devanagari; explicit
   `en` is now available and deployed.

Do **not** add noise reduction, automatic gain, or silence trimming. Levels are
healthy, clipping is negligible, and there is no measured evidence such
processing helps.


## Changes made in this work

Recording path, upload format, insertion, protocol, and API-key handling are
unchanged.

Server (deployed in `23de492`):

- `server.js` — `ruleBasedPolish` removes fillers only for the explicit
  `concise` tone; `clean` preserves every spoken word. The `/api/polish` `clean`
  prompt is punctuation/casing only and forbids adding, removing, reordering, or
  replacing words. `ruleBasedPolish` is exported on `app.locals` for tests.
- `data/dictionary.json` — added `piyush → Piyush` (`talkity → Talkity` already
  existed); the in-memory fallback was changed from `"pi yush"` to `"piyush"`.
- `test_server_transcribe.js` (new) — formatter, tone gating, language handling,
  and backward-compatible response fields.

Desktop:

- `desktop/TalkitySettings.cs` — `EnhanceText` default is now `false`.
- `desktop/TalkityApp.cs` — `DictationRules.TranscriptAfterEnhancement` rejects
  any enhancement that changes the word sequence (`WordsPreserved`,
  `ComparisonKey`, `LettersKey`). Casing, punctuation, and spacing may change.
- `desktop/TalkityTests.cs` — 6 new guard assertions, 2 rewritten.

Validation tooling (from the earlier measurement work, unchanged):

- `desktop/tools/MicValidationHarness.cs`, `score_mic.js`, `score_history.js`,
  `mic_corpus_en.json`, `mic_corpus_enhancement_off.json`,
  `validate_mic_accuracy.ps1`.
- `desktop/TalkityWhisperRecorder.cs` — internal device-selecting constructor for
  the harness. The application still opens `WAVE_MAPPER`. The drain experiment
  was reverted; this file is byte-identical to its previous revision.

Earlier pipeline changes (conservative `TalkityTextFormatter`, `normalizedText`
handling, `x-language` plumbing, recorder diagnostics) are unchanged and still
described in the section below.

## Synthetic baseline (retained for comparison)

Nine Windows TTS sentences (Microsoft Zira, 16 kHz mono) through the same
endpoint. This measures the text pipeline, not room acoustics or accent.

| Pipeline stage | Mean WER | Mean CER |
| --- | ---: | ---: |
| Raw Whisper text | 13.69% | 5.15% |
| Old server `formattedText` ("clean") | 17.03% | 7.93% |
| New `normalizedText` / desktop formatter | **13.69%** | **5.15%** |

The synthetic run showed the same defect independently: the old "clean" pass
deleted "Um" and "you know" and added 3.34 points of WER. Real speech reproduced
it on row 7 above.

## Tests

| Suite | Result |
| --- | --- |
| `build_tests_run.bat` (C# desktop) | **297 passed, 0 failed** |
| `node test.js` (dictionary) | passed |
| `node test_extension.js` (extension/protocol) | passed |
| `node test_server_transcribe.js` (mocked Groq) | passed |
| `build_app.bat` | built; app restarted, settings byte-identical |

The running app reconnected to the redeployed server over WebSocket
(`WebSocket connected` → `Server acknowledged connection` → `connected=true`),
including an automatic reconnect when Render restarted the instance mid-deploy.

## Limitations of these measurements

- One speaker, one room, one session, one device. Ten English utterances is a
  small sample; per-utterance WER has high variance (0–22% here).
- Reference 6 ("This sentence has numbers: one two three four five.") is
  **excluded** from the aggregate. Output was "This sentence has number 1, 2, 4,
  5." with digit three absent; a Whisper deletion and the speaker saying
  "1, 2, 4, 5" cannot be distinguished, so it is reported but not counted.
- The enhancement comparison is 3 paired utterances. The direction is
  consistent and the mechanism is identified in the prompt text, but the sample
  is small.
- The post-deploy comparison uses the nine synthetic TTS WAVs, because the
  real-microphone WAVs from the earlier pass were not retained. It measures the
  text pipeline; it cannot show a proper-noun improvement, and it must not be
  read as a real-microphone result.
- Explicit-language *selection* is verified (`hi` reports Hindi). Explicit-language
  *accuracy* on real speech is still unmeasured: there is no local
  `GROQ_API_KEY`, so only production can transcribe.
- The headset microphone was silent during this session (peak −43 to −50 dBFS,
  RMS −70), so no new acoustic captures could be made. The Bluetooth shortfall
  was measured in silence, which is valid for byte counts but says nothing about
  intelligibility.

## Repeating this measurement

```
node desktop/tools/score_history.js --corpus desktop/tools/mic_corpus_en.json --since <epoch-ms>
```

Or run the guided capture, which records WAVs and scores raw and formatted text
in one pass:

```
powershell -File desktop/tools/validate_mic_accuracy.ps1
```

To measure enhancement in isolation, set `"enhanceText": false` in
`%APPDATA%\Talkity\settings.json`, restart, and compare `enhanced=false` rows.
