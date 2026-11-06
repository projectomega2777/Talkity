# Talkity Desktop Application

A native Windows voice-dictation client that integrates with the Talkity WebSocket protocol v1.0.0.

## Build Instructions

### Build the application

Use the provided build scripts:

```powershell
# Windows PowerShell
build_app.bat
```

This produces `Talkity.exe` in the repository root. It requires:
- Visual C# compiler (v4.0.30319) from the .NET Framework
- System.Windows.Forms.dll
- System.Drawing.dll
- System.Speech.dll

### Build the tests

```powershell
build_tests.bat
```

This produces `TalkityTests.exe`, which runs unit tests for the protocol, JSON handling,
reconnection logic, event deduplication, audio diagnostics, transcript formatting, and
the application shell.

### Running tests

```bash
build_tests_run.bat   # compiles, then runs the suite (from the repository root)
```

or, after building:

```bash
TalkityTests.exe
```

The current suite reports **297 passed, 0 failed** on a clean compile.

## Repository Overview

- `desktop/`: C# source files
  - `TalkityApp.cs` – application shell, UI, and protocol integration
  - `TalkityHud.cs` – floating dictation indicator pill
  - `TalkityMain.cs` – main window, settings dialog (connection, history, transcript)
  - `TalkitySettings.cs` – persisted user preferences with validation
  - `TalkityPolish.cs` – optional text enhancement via the Talkity backend
  - `TalkityHistory.cs` – bounded local dictation history
  - `TalkityLog.cs` – append-only diagnostic log (no dictated content)
  - `TalkityWhisperRecorder.cs` – 16 kHz mono WinMM recorder with device/level diagnostics
  - `TalkityWhisperClient.cs` – Whisper HTTP client (language hint, normalized text)
  - `TalkityTextFormatter.cs` – conservative, non-destructive transcript formatting
  - `TalkityAudioDiagnostics.cs` – PCM16 level, clipping, and silence analysis
  - `TalkityTests.cs` – self-contained test suite
  - `WHISPER_ACCURACY_REPORT.md` – measured baseline, changes, and validation checklist
  - `TalkityWsClient.cs` – WebSocket client implementing Protocol v1.0.0 (Phase 3)
  - `test_protocol.py` – Python protocol reference for developers

- `lib/websocket-sync.js` – auxiliary Node WebSocket implementation (for reference)
- `server.js` – Talkity WebSocket server implementing the same protocol
- `extension/`, `api/`, `public/` – existing Talkity web assets and extension packages (unchanged)
- `build_app.bat`, `build_tests.bat`, `build_tests_run.bat` – build and test scripts

## Running the application

1. Ensure the Talkity backend is running (WebSocket endpoint at wss://talkity-qifh.onrender.com/).
2. Execute `Talkity.exe`.
3. Use the global hotkey (default: **F8**) in any Windows application to start/stop dictation.
4. View the floating HUD pill at the bottom-right of the screen. It displays status, timer, and connection state.
5. The main window (shown on first launch, can be hidden) shows:
   - Current transcript (last dictation session)
   - Dictation history
   - Connection and microphone status
   - Settings, clear history, and reinsert actions

## Protocol compliance

The desktop client implements Talkity WebSocket Protocol v1.0.0:

- `register_desktop`
- `heartbeat` / `heartbeat_ack`
- `inject_text`
- `desktop_status`
- `error`
- `ack`
- `history_update` / `history_cleared`
- Duplicate-event protection (1000-entry bounded HashSet)
- Exponential backoff + jitter
- Heartbeat monitoring and auto-reconnect
- All network I/O off the UI thread; no dictated text in logs

For the full message schema and connection sequence, see `PROTOCOL_SPEC.md`.

## User Settings

All preferences are persisted in `%APPDATA%\Talkity\settings.json`. Editable via the Settings dialog.

Supported settings:
- **Hotkey** – one of F6-F10, Ctrl+Shift+Space, Ctrl+Space
- **Transcription engine** – `system_speech` (offline) or `whisper`
- **Recognition language (System.Speech)** – en-US, en-GB, en-IN, en-AU
- **Whisper language** – `auto` (default, lets Whisper detect Hindi/Hinglish) or an ISO-639-1 code
- **Enhance Text** – optional AI polish via the backend
- **Enhancement Tone** – clean, concise, professional, prompt, code
- **Startup at login** – register with Windows Startup
- **Minimize to tray** – keep running when the main window is closed
- **HUD pill** – show/hide the floating indicator
- **Sound cues** – beep on dictation start/stop
- **History** – keep a bounded local dictation log
- **History limit** – number of entries to keep (10-1000)

The endpoint URL is internal-only; it defaults to the production server.

## UI/UX

- **HUD pill** – compact, always-on-top, rounded, draggable. Shows recording timer, listening/paused/processing states, and connection indicator.
- **Main window** – clean, semi-transparent, with transcript and history panes. Accessible contrast and responsive layouts.
- **System tray** – hides the main window but keeps dictation active; allows quick show/hide, settings, and exit.
- **Microphone status** – displayed in the main window; if unavailable, a friendly error is shown.
- **Keyboard shortcut** – global, respects Windows focus, with deduplication to prevent accidental overlapping sessions.
- **Text insertion** – clipboard + simulated Ctrl+V; aborts if focus moves, restores previous clipboard safely.
- **AI polish** – optional; if unavailable or fails, the raw transcript is used with a fallback cleaner.
- **History** – newest first; double-click an entry to reinsert into the current application.
- **Settings** – modal dialog with validation; applied immediately (hotkey takes effect after next registration).

## Text insertion

The application attempts to inject dictated text directly into the focused application via clipboard and simulated keystrokes.

**Success is verified by checking whether the clipboard still contains the full text after the paste attempt.**

Limitations:
- Protected fields (passwords, search boxes) typically reject Ctrl+V.
- Some editors require explicit focus or have custom input APIs.
- Windows UAC elevation may block simulated input.

When insertion fails, the text is left on the clipboard so the user can paste manually.

## AI enhancement

The polish feature is optional and uses the Talkity backend’s `/api/polish` endpoint (which may use Groq or OpenAI Whisper internally).

**No API keys are stored in the client.** The backend determines whether enhancement is available.

Enhancement options:
- **Clean** – remove filler words, correct punctuation, capitalize sentences.
- **Concise** – strip out filler and transitional phrases.
- **Professional** – polite, business-appropriate wording.
- **Prompt** – structured task description for an AI assistant.
- **Code** – comment-style formatting.

If the request times out, returns malformed data, or the backend is unreachable,
the normalized transcript is kept. Enhancement never replaces a transcript with
empty text.

## Transcription accuracy

Whisper output is cleaned with `TalkityTextFormatter`, which only adjusts
whitespace, punctuation spacing, sentence casing, and a terminal period. It
never removes filler words or reorders text. The server's older `formattedText`
"clean" pass is still returned for backward compatibility but is not used by the
desktop, because it deleted words such as "Um" and "you know".

The recorder logs the selected input device and content-free audio statistics
(peak/RMS level, clipping, leading silence, capture window) so a wrong
microphone or clipped first word is visible. Audio is uploaded unchanged; no
noise reduction, trimming, or gain is applied.

Whisper language is auto-detected by default. An explicit ISO-639-1 code is sent
only when the user selects one; region locales such as `en-IN` are rejected by
Groq and are not forwarded.

See `WHISPER_ACCURACY_REPORT.md` for the measured baseline, the before/after
WER, and the real-microphone validation checklist. The measured numbers come
from synthetic TTS, not a real microphone.

## Testing

All tests run standalone without external dependencies:
- Protocol constant validation
- JSON serialization and parsing
- Reconnection backoff with jitter
- Event deduplication with bounded memory
- Payload length validation and truncation
- Heartbeat timeout detection
- Concurrent send serialization
- Cancellation and graceful shutdown
- WebSocket registration semantics
- Settings validation and persistence (including Whisper language)
- Polish fallback on unreachable endpoints
- Hotkey guard logic
- Audio diagnostics (level, clipping, silence)
- WAV header/word-alignment format
- Text formatter word-preservation and WER regression

Run the C# suite with `build_tests_run.bat` (compiles and runs
`TalkityTests.exe` from the repository root). The current suite reports **297 passed, 0 failed**.

Run the Node suites with:

```bash
npm run test:all   # dictionary + extension/protocol + mocked server
```

`test_server_transcribe.js` mocks Groq: it needs no API key and makes no
network call to Groq.

## Security

- No dictated audio, transcripts, or settings are stored in logs.
- API keys and secrets never enter the client.
- All network traffic goes through the WebSocket protocol.
- Clipboard handling preserves previous contents.
- Payloads are validated and truncated.
- Input validation is applied to all configuration and user data.
- WebSocket messages are parsed with a minimal JSON parser; malformed input yields empty results.

## Updates and maintenance

This repository is built with the aim of a stable, native Windows experience. New features are added as separate phases to avoid destabilizing the protocol and UI.

## Licensing

Talkity is proprietary software. The source code is not published under an open-source license and is not offered for public redistribution; usage terms are provided by the rights holder through official channels. Third-party components used by the product remain subject to their own licenses.

---

*This README was generated by Claude Code as part of the Talkity Desktop modernization effort.*