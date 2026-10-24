# 🎙️ Talkity — Voice-to-Text Dictation Platform

> **Speak naturally. Talkity listens, transcribes, and polishes your words in real time with enterprise-grade security.**

Talkity is a modern, real-time voice dictation platform and companion Windows desktop application. It captures acoustic audio, transcribes it with high precision across accents (including Indian English and Hindi), polishes grammar and formatting, and seamlessly injects output into your favorite apps.

---

## ✨ Features

- 🎤 **Real-Time Speech Recognition** — Instantaneous client-side and cloud transcription powered by Web Speech API and Groq/OpenAI Whisper.
- 🔄 **Fresh Page on Refresh** — Every time the website refreshes, past session history is automatically cleared and resets into a clean, distraction-free playground.
- 🌐 **Multi-Language & Accent Optimized** — Native support for English (India), English (US), English (UK), and Hindi / Hinglish.
- ✍️ **Intelligent AI Text Polish** — Automatically eliminates vocal fillers (*um*, *uh*, *you know*), cleans punctuation, and normalizes casing.
- 🎨 **Multi-Tone Adaptation** — Switch between Clean Natural, Punchy Concise, Executive Professional, AI Prompt Engineer, and Developer Code comments.
- 🧪 **Interactive App Sandboxes** — Test real-time dictation directly into simulated Slack, VS Code, Gmail, and Document note editors.
- 📖 **Custom Vocabulary & Dictionary** — Define personal phrases, jargon, and shorthand with automated auto-correction replacements.
- 📋 **Zero-Friction Clipboard** — Auto-copy to clipboard and simulated active window paste (`Ctrl+V`).
- 🌙 **Dark-Mode Modern UI** — Sleek responsive interface with real-time audio spectrum visualization.

---

## 🛡️ Security Architecture & Hardening

Talkity adheres to defense-in-depth security best practices:

- 🔒 **No API Key Leakage:** Sensitive server keys (`GROQ_API_KEY`, `OPENAI_API_KEY`) are **never** exposed to clients. `GET /api/settings` returns only boolean feature flags (`hasGroqKey`, `hasOpenaiKey`), keeping credentials secret.
- 🚦 **Sliding-Window Rate Limiting:** All API endpoints are protected by IP-based sliding-window rate limiters (120 req/min for general routes, 35 req/min for AI endpoints), mitigating DDoS, brute force, and LLM billing abuse.
- 🛡️ **HTTP Security Headers:**
  - `Content-Security-Policy (CSP)` restricts script, style, and media execution.
  - `X-Frame-Options: DENY` prevents Clickjacking.
  - `X-Content-Type-Options: nosniff` stops MIME-type sniffing.
  - `Strict-Transport-Security (HSTS)` enforces HTTPS.
  - `Permissions-Policy: microphone=(self)` restricts microphone access exclusively to the application origin.
  - Software stack disclosure is silenced (`app.disable('x-powered-by')`).
- 🧹 **XSS Defense:** All user input, history entries, custom vocabulary, and raw speech streams are sanitized and rendered using native DOM text nodes (`textContent`), neutralizing Cross-Site Scripting (XSS).
- ⚡ **ReDoS Mitigation:** Regular expression inputs in the custom dictionary are strictly escaped and length-bounded to prevent catastrophic backtracking.
- 📦 **Payload Limits:** Strict payload guards (100KB for JSON, 10MB for audio uploads) prevent buffer overflow and memory exhaustion attacks.

---

## 🚀 Getting Started

### Prerequisites

- **[Node.js](https://nodejs.org/)** (v16 or higher)
- **Google Chrome** or Microsoft Edge (recommended for Web Speech API)

### 1. Clone the Repository

```bash
git clone git@github.com:projectomega2777/talkity.git
cd talkity
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Launch the Server

```bash
node server.js
```

The server will be accessible at:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 🎯 How to Use

1. Navigate to `http://localhost:3000` (or `https://talkity.vercel.app`).
2. Select your language from the control bar dropdown (e.g., **English (India)** or **English (US)**).
3. Click **Start Dictating** or tap the <kbd>Space</kbd> bar.
4. Speak naturally into your microphone.
5. Hit **Finish Dictating** to polish and automatically copy the output to your clipboard!
6. Want a fresh start? Simply **refresh the page** (F5 / Ctrl+R) — history is automatically cleared and all inputs reset to fresh.

---

## 🖥️ Windows Desktop HUD App Source (`desktop/`)

Talkity includes source code for an optional Windows desktop companion HUD pill located in `desktop/`:

- **Global Hotkey:** Press <kbd>F8</kbd> anywhere in Windows to start recording; press <kbd>F8</kbd> again to finish.
- **HUD Pill:** Floating always-on-top status pill displays current recording state.
- **Auto-Paste:** Automatically restores your clipboard and types the polished transcript into whatever app currently has focus.

To compile the C# source code on Windows:
```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /out:Talkity.exe desktop/TalkityApp.cs
```

---

## 📁 Repository Structure

```
talkity/
├── server.js              # Hardened Express + WebSocket server
├── vercel.json            # Vercel serverless routing configuration
├── index.html             # Root web application document
├── package.json           # Node.js dependencies and scripts
├── api/
│   └── index.js           # Vercel serverless function entrypoint
├── desktop/
│   ├── TalkityApp.cs                      # C# source code for Windows HUD overlay
│   ├── talkity_desktop.py                 # Original Python desktop client
│   └── talkity_desktop_enhanced.py        # Enhanced client with WebSocket protocol v1.0.0
├── public/
│   ├── index.html         # Web application UI
│   ├── app.js             # Client speech engine & XSS-safe UI controller
│   └── styles.css         # Dark theme styling & audio visualizer
├── data/
│   ├── dictionary.json    # Custom vocabulary replacement rules
│   └── history.json       # Local dictation history
└── README.md              # Project documentation
```

---

## 🔌 REST & WebSocket API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/transcribe` | Upload WAV audio buffer for Whisper transcription (Rate-limited, max 10MB) |
| `POST` | `/api/polish` | Transform raw text with selected tone & custom vocabulary (Rate-limited) |
| `GET`  | `/api/history` | Retrieve saved transcriptions |
| `POST` | `/api/history` | Store transcription record |
| `DELETE`| `/api/history` | Clear all past session transcriptions |
| `GET`  | `/api/dictionary` | List custom replacement dictionary |
| `POST` | `/api/dictionary` | Add new phrase replacement rule (Max 100 rules) |
| `DELETE`| `/api/dictionary/:id` | Remove a rule from dictionary |
| `GET`  | `/api/settings` | Retrieve safe settings flags (Keys masked) |
| `POST` | `/api/settings` | Update settings preferences |
| `WS`   | `ws://localhost:3000` | Real-time bridge between Web UI and Desktop HUD |

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, WebSocket (`ws`), dotenv, cors
- **Frontend:** Vanilla JavaScript (ES6+), Web Audio API, Web Speech API, HTML5 Canvas
- **Desktop:** C# (.NET Framework 4.0 Win32 APIs)
- **ASR & AI:** Web Speech API, Groq Cloud Whisper, OpenAI Whisper

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

## 👤 Author

Developed by **[projectomega2777](https://github.com/projectomega2777)**
