# Talkity Whisper vs System.Speech — Comparison Scorecard

**Date:** 2026-10-26  
**Build:** Talkity.exe (73728 bytes)  
**Server:** https://talkity-qifh.onrender.com/  
**Tester:** ________________

---

## Scoring Guide

| Rating | Accuracy Description |
|--------|---------------------|
| 5 | Perfect — matches reference exactly |
| 4 | Minor errors (1-2 words wrong, punctuation) |
| 3 | Understandable but multiple errors |
| 2 | Major errors, hard to understand |
| 1 | Unusable / garbled |

---

## Whisper Engine Results

### English (10 sentences)

| # | Reference | Transcript | Time (s) | Inserted? | Rating (1-5) | Error Notes |
|---|-----------|------------|----------|-----------|--------------|-------------|
| 1 | The quick brown fox jumps over the lazy dog. | | | | | |
| 2 | Hello world, how are you today? | | | | | |
| 3 | Please dictate this sentence accurately. | | | | | |
| 4 | Voice dictation should work reliably now. | | | | | |
| 5 | I am testing the Whisper transcription engine. | | | | | |
| 6 | Talkity connects to the server for processing. | | | | | |
| 7 | The audio is sent as a WAV file over HTTPS. | | | | | |
| 8 | Transcription usually takes a few seconds. | | | | | |
| 9 | This sentence has numbers: one two three four five. | | | | | |
| 10 | End of English test, switching languages now. | | | | | |

**English Summary (Whisper):**  
- Avg Time: ___ s  
- Insertion Rate: ___/10  
- Avg Rating: ___/5  
- Common Errors: ________________

---

### Hindi (10 sentences)

| # | Reference | Transcript | Time (s) | Inserted? | Rating (1-5) | Error Notes |
|---|-----------|------------|----------|-----------|--------------|-------------|
| 1 | नमस्ते, आप कैसे हैं? | | | | | |
| 2 | मैं एक स्वास्थ्यपूर्ण व्यक्ति हूँ। | | | | | |
| 3 | कृपया इस वाक्य को सही से लिखें। | | | | | |
| 4 | आवाज़ से टाइप करना बहुत आसान है। | | | | | |
| 5 | मैं हिंदी में बोल रहा हूँ। | | | | | |
| 6 | यह व्हिस्पर इंजन का परीक्षण है। | | | | | |
| 7 | सर्वर पर ऑडियो भेजा जाता है। | | | | | |
| 8 | ट्रांसक्रिप्शन कुछ सेकंड लेता है। | | | | | |
| 9 | इसमें नंबर हैं: एक दो तीन चार पाँच। | | | | | |
| 10 | हिंदी परीक्षण समाप्त, अब हिंग्लिश। | | | | | |

**Hindi Summary (Whisper):**  
- Avg Time: ___ s  
- Insertion Rate: ___/10  
- Avg Rating: ___/5  
- Common Errors: ________________

---

### Hinglish (10 sentences)

| # | Reference | Transcript | Time (s) | Inserted? | Rating (1-5) | Error Notes |
|---|-----------|------------|----------|-----------|--------------|-------------|
| 1 | Main Whisper engine test kar raha hoon. | | | | | |
| 2 | Ye sentence Hindi aur English mix hai. | | | | | |
| 3 | Kya aap mujhe sun sakte hain? | | | | | |
| 4 | Voice dictation bahut useful hai. | | | | | |
| 5 | Server par audio bhej ke transcript milta hai. | | | | | |
| 6 | Yeh test 10 sentences ka hai. | | | | | |
| 7 | Main Notepad mein type kar raha hoon. | | | | | |
| 8 | Clipboard par bhi text copy hota hai. | | | | | |
| 9 | Hinglish mein bolna natural lagta hai. | | | | | |
| 10 | Hinglish test complete, ab System.Speech try karenge. | | | | | |

**Hinglish Summary (Whisper):**  
- Avg Time: ___ s  
- Insertion Rate: ___/10  
- Avg Rating: ___/5  
- Common Errors: ________________

---

## System.Speech Engine Results

### English (10 sentences) — Baseline

| # | Reference | Transcript | Time (s) | Inserted? | Rating (1-5) | Error Notes |
|---|-----------|------------|----------|-----------|--------------|-------------|
| 1 | The quick brown fox jumps over the lazy dog. | | | | | |
| 2 | Hello world, how are you today? | | | | | |
| 3 | Please dictate this sentence accurately. | | | | | |
| 4 | Voice dictation should work reliably now. | | | | | |
| 5 | I am testing the Whisper transcription engine. | | | | | |
| 6 | Talkity connects to the server for processing. | | | | | |
| 7 | The audio is sent as a WAV file over HTTPS. | | | | | |
| 8 | Transcription usually takes a few seconds. | | | | | |
| 9 | This sentence has numbers: one two three four five. | | | | | |
| 10 | End of English test, switching languages now. | | | | | |

**English Summary (System.Speech):**  
- Avg Time: ___ s  
- Insertion Rate: ___/10  
- Avg Rating: ___/5  
- Common Errors: ________________

---

### Hindi (10 sentences) — Expected Poor

| # | Reference | Transcript | Time (s) | Inserted? | Rating (1-5) | Error Notes |
|---|-----------|------------|----------|-----------|--------------|-------------|
| 1 | नमस्ते, आप कैसे हैं? | | | | | |
| 2 | मैं एक स्वास्थ्यपूर्ण व्यक्ति हूँ। | | | | | |
| 3 | कृपया इस वाक्य को सही से लिखें। | | | | | |
| 4 | आवाज़ से टाइप करना बहुत आसान है। | | | | | |
| 5 | मैं हिंदी में बोल रहा हूँ। | | | | | |
| 6 | यह व्हिस्पर इंजन का परीक्षण है। | | | | | |
| 7 | सर्वर पर ऑडियो भेजा जाता है। | | | | | |
| 8 | ट्रांसक्रिप्शन कुछ सेकंड लेता है। | | | | | |
| 9 | इसमें नंबर हैं: एक दो तीन चार पाँच। | | | | | |
| 10 | हिंदी परीक्षण समाप्त, अब हिंग्लिश। | | | | | |

**Hindi Summary (System.Speech):**  
- Avg Time: ___ s  
- Insertion Rate: ___/10  
- Avg Rating: ___/5  
- Common Errors: ________________  
- **Expected:** Garbled/English-phonetic output (no Hindi recognizer installed)

---

### Hinglish (10 sentences) — Expected Poor

| # | Reference | Transcript | Time (s) | Inserted? | Rating (1-5) | Error Notes |
|---|-----------|------------|----------|-----------|--------------|-------------|
| 1 | Main Whisper engine test kar raha hoon. | | | | | |
| 2 | Ye sentence Hindi aur English mix hai. | | | | | |
| 3 | Kya aap mujhe sun sakte hain? | | | | | |
| 4 | Voice dictation bahut useful hai. | | | | | |
| 5 | Server par audio bhej ke transcript milta hai. | | | | | |
| 6 | Yeh test 10 sentences ka hai. | | | | | |
| 7 | Main Notepad mein type kar raha hoon. | | | | | |
| 8 | Clipboard par bhi text copy hota hai. | | | | | |
| 9 | Hinglish mein bolna natural lagta hai. | | | | | |
| 10 | Hinglish test complete, ab System.Speech try karenge. | | | | | |

**Hinglish Summary (System.Speech):**  
- Avg Time: ___ s  
- Insertion Rate: ___/10  
- Avg Rating: ___/5  
- Common Errors: ________________  
- **Expected:** Garbled/English-phonetic output (no Hindi recognizer installed)

---

## Comparison Summary

| Metric | Whisper (English) | System.Speech (English) | Whisper (Hindi) | System.Speech (Hindi) | Whisper (Hinglish) | System.Speech (Hinglish) |
|--------|-------------------|-------------------------|-----------------|----------------------|--------------------|--------------------------|
| Avg Transcription Time | | | | | | |
| Insertion Success Rate | | | | | | |
| Accuracy Rating (avg) | | | | | | |
| Usable for Production? | | | | | | |

---

## Decision Matrix

| Criterion | Pass Threshold | Whisper Result | Verdict |
|-----------|----------------|----------------|---------|
| English accuracy ≥ System.Speech | Whisper avg rating ≥ System.Speech avg rating | | |
| Hindi usable (rating ≥ 3) | Avg rating ≥ 3.0 | | |
| Hinglish usable (rating ≥ 3) | Avg rating ≥ 3.0 | | |
| Insertion success ≥ 90% | ≥ 9/10 per language | | |
| No blocking regressions | All edge cases pass | | |
| Latency acceptable | < 15s (server timeout) | | |

**Recommendation:**  
- [ ] Switch default engine to `whisper`  
- [ ] Keep default as `system_speech` (more validation needed)  
- [ ] Block: _________________________________

---

## Known Issues / Blockers

| # | Issue | Engine | Severity | Workaround |
|---|-------|--------|----------|------------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

---

## Server Logs (for debugging)

- Server endpoint: `https://talkity-qifh.onrender.com/api/transcribe`
- Provider used (from response): `groq-whisper-large-v3` or `openai-whisper`
- Check server logs for: audio size, processing time, errors

---

**Completed:** ________________  
**Signature:** ________________