# Talkity Chrome/Edge Extension — Phase 4 Installation & Usage Guide

## Overview

The Talkity Chrome/Edge extension enables voice dictation directly into web page input fields and contenteditable elements. It connects to the Talkity WebSocket server (Node.js backend) and relays transcriptions, polishing requests, and text injections.

**Key Features:**
- Real-time voice transcription using Web Speech API
- Optional server-side AI polishing (Groq/OpenAI)
- One-click text injection into active web forms
- Status indicator showing connection to Talkity server
- Configurable server URL for local or cloud deployments

---

## Files Structure

```
extension/
├── manifest.json              # Manifest V3 configuration
├── src/
│   ├── background.js          # Service Worker (WebSocket relay)
│   ├── content.js             # Content Script (text injection)
│   ├── popup.html             # Popup UI
│   └── popup.js               # Popup logic (recording, speech API)
└── assets/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation (Development Mode)

### Prerequisites
- Chrome 88+ or Edge 88+ (Manifest V3 support)
- Talkity server running: `node server.js` (default: `ws://localhost:3000`)
- Node.js 14+ (for server only)

### Steps

1. **Open Chrome/Edge Extensions Manager:**
   ```
   chrome://extensions  (Chrome)
   edge://extensions    (Edge)
   ```

2. **Enable Developer Mode** (top-right toggle)

3. **Click "Load unpacked"** and select the `extension/` directory:
   ```
   D:\System PC\talkity\extension
   ```

4. **Verify Installation:**
   - Extension icon should appear in the toolbar
   - Click the icon to open the popup
   - Verify status shows "Connected to Bridge" or "Disconnected (Using local speech)"

---

## Configuration

### Server URL

The extension defaults to `ws://localhost:3000`. To change:

1. Click the extension popup
2. At the bottom, update **"Talkity Server URL"**
3. Press Enter or click outside the input
4. Extension will reload and reconnect

**Examples:**
- Local development: `ws://localhost:3000`
- Vercel deployment: `wss://talkity.vercel.app` (note: `wss://` for HTTPS)
- Docker container: `ws://host.docker.internal:3000`

---

## Usage

### Basic Voice Dictation

1. **Focus a text input** (textarea, input field, or contenteditable div)
2. **Click the extension icon** to open the popup
3. **Click "Start Recording"** (button turns red)
4. **Speak naturally** — the transcript appears in real-time
5. **Click "Stop Recording"** when done
6. **Text is injected** into the focused element automatically

### With Server-Side Polishing

If Talkity server has AI keys configured (`GROQ_KEY` or `OPENAI_KEY` in `.env`):

1. Dictate and record as above
2. On the **web dashboard** (`http://localhost:3000`):
   - View the raw transcription
   - Select a tone (clean, casual, formal, etc.)
   - Click "Polish with AI"
3. **"Send to Desktop"** button broadcasts to all connected clients (extension, desktop HUD, etc.)
4. The polished text is injected into your active web element

---

## Protocol Details

### WebSocket Connection Flow

1. **Background Service Worker** connects to `ws://localhost:3000`
2. **Registers** with message:
   ```json
   {
     "type": "register_extension",
     "clientId": "ext-xxxxxxxx",
     "protocolVersion": "1.0.0",
     "timestamp": 1634567890000
   }
   ```
3. **Listens for heartbeat** and server messages:
   - `{"type": "heartbeat", "timestamp": N}` → responds with `heartbeat_ack`
   - `{"type": "inject_text", "text": "...", "eventId": "..."}` → relays to Content Script
4. **Content Script** injects text into the active tab's focused element

### Message Types

**Popup → Background:**
```json
{
  "action": "send_transcription",
  "text": "Hello world",
  "tone": "clean"
}
```

**Background → Content Script (via chrome.tabs.sendMessage):**
```json
{
  "action": "talkity_inject",
  "text": "Hello world"
}
```

**Background ↔ Server (WebSocket):**
- Server sends `inject_text` with `eventId` (broadcast from web polish)
- Background sends `transcription` with raw/polished text from local dictation
- Both respond to heartbeats with `heartbeat_ack`

---

## Security & Privacy

- **No secrets embedded:** API keys (Groq, OpenAI) are configured on the server in `.env`, never in the extension
- **Local-first:** Transcription defaults to Web Speech API (local), no data sent to external services unless explicitly configured on server
- **CORS & CSP:** Server enforces strict headers; extension respects them
- **Clipboard fallback:** If text injection fails, text is written to clipboard as fallback
- **Credential protection:** Extension never stores or transmits user API keys

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Popup shows "Disconnected"** | Ensure server is running: `node server.js`. Check "Talkity Server URL" matches the running instance. |
| **Text not injecting** | Ensure element is focused (blue border/cursor visible). Try typing manually first to confirm element accepts input. |
| **Speech not recognized** | Check browser permissions: Settings → Privacy → Microphone. Reload the extension if permission was just granted. |
| **Transcript empty** | Speak clearly and wait 1–2 seconds. Some accents/languages may have reduced accuracy with Web Speech API. |
| **Can't load extension** | Verify `manifest.json`, `src/background.js`, and `src/content.js` exist. Check Console for errors (`chrome://extensions/` → Details → Errors). |

---

## Development & Testing

### Local Testing (All Components)

```bash
# Terminal 1: Start server
cd D:\System PC\talkity
node server.js

# Terminal 2: Open a text editor or web page
# e.g., Notepad, Gmail, Slack web, Discord web, etc.

# Extension is auto-loaded in Chrome/Edge (steps above)
# Dictate using the popup, verify text appears
```

### Logs

- **Background Service Worker logs:** `chrome://extensions` → Talkity Voice Dictation → "Service Worker" link
- **Content Script logs:** Open page DevTools (F12) → Console
- **Server logs:** Terminal where `node server.js` is running

### Building for Release

To package for distribution to Chrome Web Store:

1. Remove development files (optional):
   ```bash
   # Keep manifest.json, src/, assets/ only
   ```

2. Create a .zip:
   ```bash
   cd extension
   Compress-Archive -Path * -DestinationPath talkity-extension.zip
   ```

3. Upload to [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole)

---

## Architecture Notes

- **Manifest V3:** Uses Service Workers instead of Background Pages for better performance and security
- **Content Script Isolation:** Operates in the page's execution context; can safely interact with form elements
- **No persistent popup:** Popup is transient; state is stored in `chrome.storage.local` for persistence across sessions
- **Dual-mode fallback:** Works with or without server (Web Speech API is self-contained)

---

## Next Steps (Future Enhancements)

- [ ] Add settings: language, mic sensitivity, auto-send on pause
- [ ] Support for more tone options (sarcasm, poetic, code-format, etc.)
- [ ] Integration with browser history for context-aware polishing
- [ ] Extension icon badging (e.g., "REC" when recording)
- [ ] Right-click context menu to inject polished text
- [ ] Support for multiple window management (inject into specific tab)

---

**Version:** 1.0.0  
**Talkity Protocol:** v1.0.0  
**Last Updated:** 2026-10-24
