# Talkity Manual Validation Checklist — Whisper Desktop Transcription

**Version:** 1.1.0 (sections 1–9 were written for 1.0; the transcription code is unchanged)  
**Date:** 2026-10-26, installer section added 2026-10-28  
**Build:** Talkity.exe (124,928 bytes), TalkitySetup.exe (2,140,042 bytes)  
**Server:** https://talkity-qifh.onrender.com/

---

## 0. Pre-Test Setup

- [ ] Close all other Talkity instances (single-instance mutex enforced)
- [ ] Ensure microphone is connected and set as Windows default input
- [ ] Verify network connectivity to `https://talkity-qifh.onrender.com/`
- [ ] Confirm server has valid `GROQ_API_KEY` or `OPENAI_API_KEY` in environment
- [ ] Open Windows **Sound Settings** → **Input** → verify microphone level moves when speaking
- [ ] Have **Notepad** and a **browser text field** (e.g., `https://talkity-qifh.onrender.com/` or any `<input>`/`<textarea>`) ready

---

## 1. Launch and Engine Selection

| Step | Action | Expected Result | Pass/Fail | Notes |
|------|--------|-----------------|-----------|-------|
| 1.1 | Double-click `Talkity.exe` | App starts, tray icon appears, main window visible, HUD shows if enabled | | |
| 1.2 | Press `F8` or tray → Settings | Settings dialog opens | | |
| 1.3 | Set "Transcription engine" → `whisper` | Combo shows `whisper` and `system_speech` | | |
| 1.4 | Click **Save** | Dialog closes, settings persisted | | |
| 1.5 | Re-open Settings | Engine still shows `whisper` | | |
| 1.6 | Switch back to `system_speech`, Save | Engine persists as `system_speech` | | |

---

## 2. Basic Recording (Whisper Engine)

| Step | Action | Expected Result | Pass/Fail | Notes |
|------|--------|-----------------|-----------|-------|
| 2.1 | Select `whisper` engine, Save | Engine active | | |
| 2.2 | Click into **Notepad** (make it foreground) | Notepad has focus | | |
| 2.3 | Press `F8` (hotkey) | HUD → "Listening...", tray → "Talkity - listening", two beeps | | |
| 2.4 | Speak: "Hello world this is a test" (clear, ~2 sec) | Audio captured | | |
| 2.5 | Press `F8` again | HUD → "Processing...", then "Inserted (enhanced)" or "Inserted" | | |
| 2.6 | Check Notepad | Text appears at cursor position | | |
| 2.7 | Check clipboard (`Ctrl+V` in empty Notepad) | Same transcript on clipboard | | |
| 2.8 | Check HUD after 2.5 sec | Returns to "Talkity - F8" | | |

---

## 3. Language Tests — 10 Sentences Each

**Method:** For each sentence below:
1. Focus target (Notepad or browser field)
2. Press `F8` → speak sentence → press `F8`
3. Record: **Transcript**, **Time (approx)**, **Inserted?**, **Errors**

### 3.1 English (Whisper)

| # | Reference Sentence | Transcript | Time (s) | Inserted? | Errors |
|---|-------------------|------------|----------|-----------|--------|
| 1 | The quick brown fox jumps over the lazy dog. | | | | |
| 2 | Hello world, how are you today? | | | | |
| 3 | Please dictate this sentence accurately. | | | | |
| 4 | Voice dictation should work reliably now. | | | | |
| 5 | I am testing the Whisper transcription engine. | | | | |
| 6 | Talkity connects to the server for processing. | | | | |
| 7 | The audio is sent as a WAV file over HTTPS. | | | | |
| 8 | Transcription usually takes a few seconds. | | | | |
| 9 | This sentence has numbers: one two three four five. | | | | |
| 10 | End of English test, switching languages now. | | | | |

### 3.2 Hindi (Whisper)

| # | Reference Sentence | Transcript | Time (s) | Inserted? | Errors |
|---|-------------------|------------|----------|-----------|--------|
| 1 | नमस्ते, आप कैसे हैं? | | | | |
| 2 | मैं एक स्वास्थ्यपूर्ण व्यक्ति हूँ। | | | | |
| 3 | कृपया इस वाक्य को सही से लिखें। | | | | |
| 4 | आवाज़ से टाइप करना बहुत आसान है। | | | | |
| 5 | मैं हिंदी में बोल रहा हूँ। | | | | |
| 6 | यह व्हिस्पर इंजन का परीक्षण है। | | | | |
| 7 | सर्वर पर ऑडियो भेजा जाता है। | | | | |
| 8 | ट्रांसक्रिप्शन कुछ सेकंड लेता है। | | | | |
| 9 | इसमें नंबर हैं: एक दो तीन चार पाँच। | | | | |
| 10 | हिंदी परीक्षण समाप्त, अब हिंग्लिश। | | | | |

### 3.3 Hinglish (Whisper)

| # | Reference Sentence | Transcript | Time (s) | Inserted? | Errors |
|---|-------------------|------------|----------|-----------|--------|
| 1 | Main Whisper engine test kar raha hoon. | | | | |
| 2 | Ye sentence Hindi aur English mix hai. | | | | |
| 3 | Kya aap mujhe sun sakte hain? | | | | |
| 4 | Voice dictation bahut useful hai. | | | | |
| 5 | Server par audio bhej ke transcript milta hai. | | | | |
| 6 | Yeh test 10 sentences ka hai. | | | | |
| 7 | Main Notepad mein type kar raha hoon. | | | | |
| 8 | Clipboard par bhi text copy hota hai. | | | | |
| 9 | Hinglish mein bolna natural lagta hai. | | | | |
| 10 | Hinglish test complete, ab System.Speech try karenge. | | | | |

---

## 4. System.Speech Engine Comparison (Same Sentences)

Repeat **Section 3** with engine set to `system_speech` in Settings.

| # | Language | Engine | Transcript | Time (s) | Inserted? | Errors |
|---|----------|--------|------------|----------|-----------|--------|
| 1-10 | English | system_speech | | | | |
| 1-10 | Hindi | system_speech | | | | |
| 1-10 | Hinglish | system_speech | | | | |

> **Note:** System.Speech only has `en-US` recognizer installed. Hindi/Hinglish will likely produce garbled output — this is expected and documented.

---

## 5. Edge Cases & Error Handling

| # | Scenario | Steps | Expected Behavior | Pass/Fail | Notes |
|---|----------|-------|-------------------|-----------|-------|
| 5.1 | **Empty recording** | Press `F8`, wait 0.5s, press `F8` without speaking | HUD → "Nothing recognized" or similar; no text inserted | | |
| 5.2 | **Microphone failure** | Disable microphone in Windows Settings, press `F8` | Error shown in HUD/main; no crash | | |
| 5.3 | **Network error** | Disconnect internet, press `F8`, speak, press `F8` | "Transcription failed - check your connection" | | |
| 5.4 | **Timeout** | (If server slow) Wait >15s during processing | Request times out, error reported gracefully | | |
| 5.5 | **Very short clip** | Press `F8`, say "Hi", press `F8` immediately (<500ms) | "Recording too short" or handled gracefully | | |
| 5.6 | **Target = Talkity window** | Press `F8` while Talkity main window focused | "Talkity is the active window, so the text was copied instead" | | |
| 5.7 | **Clipboard preservation** | Copy "user text" → dictate → verify clipboard has transcript → wait 2s → verify clipboard restored to "user text" | Previous clipboard restored after delay if unchanged | | |
| 5.8 | **Clipboard overwrite protection** | Dictate → immediately copy "other text" in another app → wait 2s | User's "other text" NOT overwritten by restore | | |
| 5.9 | **Repeated sessions** | 5 dictations in a row (different sentences) | Each inserts correctly, no duplicate insertions | | |
| 5.10 | **Duplicate insertion guard** | Press `F8` rapidly 3x during "Processing..." | Only one insertion occurs | | |

---

## 6. Browser Text Field Insertion

| Step | Action | Expected Result | Pass/Fail | Notes |
|------|--------|-----------------|-----------|-------|
| 6.1 | Open browser to any page with `<textarea>` or `<input>` | Field focusable | | |
| 6.2 | Click field, press `F8`, speak "Browser test sentence", press `F8` | Text inserted at cursor in field | | |
| 6.3 | Verify clipboard also has transcript | `Ctrl+V` elsewhere shows same text | | |
| 6.4 | Test in Talkity web app (https://talkity-qifh.onrender.com/) | Works in extension context too | | |

---

## 7. HUD State Transitions

| Transition | Trigger | Expected HUD Text | Pass/Fail |
|------------|---------|-------------------|-----------|
| Idle → Listening | `F8` (start) | "Listening..." | |
| Listening → Paused | HUD click or tray → Pause | "Paused" | |
| Paused → Listening | HUD click or `F8` | "Listening..." | |
| Listening → Processing | `F8` (stop) | "Processing..." | |
| Processing → Inserted | Success | "Inserted" or "Inserted (enhanced)" | |
| Processing → Error | Failure | "Nothing recognized" / "Transcription failed" / "Copied to clipboard" | |
| Any → Idle (auto) | 2.5s after feedback | "Talkity - F8" | |

---

## 8. History & Reinsertion

| Step | Action | Expected Result | Pass/Fail |
|------|--------|-----------------|-----------|
| 8.1 | Complete 3 dictations with `Keep history` ON | History shows 3 entries with timestamps | |
| 8.2 | Click **Reinsert** on entry 1 | Text inserted into current foreground app | |
| 8.3 | Click **Clear history** | History emptied | |
| 8.4 | Verify `Copy transcript` button | Last transcript copied to clipboard | |

---

## 9. Latency & Responsiveness

| Metric | Measurement Method | Target | Observed |
|--------|-------------------|--------|----------|
| Hotkey → HUD "Listening..." | Stopwatch | < 200 ms | |
| Stop speaking → HUD "Processing..." | Stopwatch | < 500 ms | |
| Processing → Inserted (Whisper) | Stopwatch | < 15 s (server timeout) | |
| Processing → Inserted (System.Speech) | Stopwatch | < 3 s | |
| UI responsiveness during recording | Observe | No freeze/lag | |
| UI responsiveness during processing | Observe | Main window responsive | |

---

## 10. Installer, Upgrade and Distribution Checks (Talkity 1.1.0)

Run these against `release\output\TalkitySetup.exe` on a clean machine. The
desktop build and installer were exercised per-user on Windows 10 during the
release session; every row below is still outstanding.

| # | Action | Expected Result | Pass/Fail |
|---|--------|-----------------|-----------|
| 10.1 | Install on a clean Windows 10 machine as administrator | UAC prompt, installs to `C:\Program Files\Talkity`, Start Menu entry created | |
| 10.2 | Install on a clean Windows 11 machine as administrator | Same as 10.1 (Windows 11 untested at release time) | |
| 10.3 | Run `TalkitySetup.exe /CURRENTUSER` as a standard user | No UAC prompt, installs to `%LOCALAPPDATA%\Programs\Talkity` | |
| 10.4 | Open Settings → Apps → Installed apps | Exactly one "Talkity 1.1.0" entry, publisher Talkity, correct icon | |
| 10.5 | Launch from the Start Menu, dictate, insert into Notepad | Text inserted at the caret; HUD transitions Listening → Processing → result | |
| 10.6 | Run the installer again while Talkity is running | App closes, files replaced, app relaunches in the background and reconnects | |
| 10.7 | Check settings, hotkey and HUD position after the upgrade | Unchanged from before the upgrade | |
| 10.8 | Uninstall via Settings → Apps → Talkity → Uninstall | App files, both shortcuts and the Apps & Features entry removed | |
| 10.9 | Check `%APPDATA%\Talkity` after uninstall | `settings.json`, `history.json` and `talkity.log` still present and unmodified | |
| 10.10 | First run on a machine that has never seen the installer | SmartScreen reports "unknown publisher"; "More info → Run anyway" completes | |
| 10.11 | Scan installer and installed exe with Defender plus one third-party AV | No quarantine, no false positive | |
| 10.12 | Enable "Launch at startup" in Settings, then reboot | Tray app starts hidden with no main window and the WebSocket connects | |

---

## 11. Sign-Off

| Engine | Language | Sentences Tested | Avg Transcription Time | Insertion Success Rate | Accuracy Rating (1-5) | Blocker? |
|--------|----------|------------------|------------------------|------------------------|------------------------|----------|
| Whisper | English | 10/10 | | | | |
| Whisper | Hindi | 10/10 | | | | |
| Whisper | Hinglish | 10/10 | | | | |
| System.Speech | English | 10/10 | | | | |
| System.Speech | Hindi | 10/10 | | | | |
| System.Speech | Hinglish | 10/10 | | | | |

**Overall Assessment:**  
- [ ] Whisper accuracy ≥ System.Speech for English  
- [ ] Whisper accuracy usable for Hindi  
- [ ] Whisper accuracy usable for Hinglish  
- [ ] No blocking regressions found  
- [ ] Ready to switch default engine to `whisper`

**Tester:** ________________  
**Date:** ________________  
**Build:** Talkity.exe (73728 bytes)