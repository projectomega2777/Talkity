# 🎙️ Talkity — AI Voice Dictation & Context-Aware Text Engine

> **Speak naturally. Talkity listens, transcribes, and polishes your words in real time.**

**Talkity** is a proprietary, AI-powered voice dictation platform that turns spoken language into clean, context-aware written text — and delivers it into the applications you already use.

Talkity combines high-quality speech recognition, AI text refinement, and contextual routing into a single product experience — for dictation in the browser, on desktop, and through an extension.

---

## ✨ Key Features

- **🎤 Real-time speech recognition**
  - Web Speech API, Groq Whisper (`whisper-large-v3`), or OpenAI Whisper (`whisper-1`)
  - Automatic language handling: English (India / US / UK), Hindi, Hinglish, and additional Whisper-supported languages
- **✍️ AI text polishing**
  - Multiple tones: Clean, Concise, Professional, Prompt, Code
  - Filler-word handling, punctuation and capitalization normalization
- **🧠 Custom vocabulary**
  - Phrase → replacement dictionary (up to 100 rules)
- **🌐 Live web playground**
  - Dictation, transcripts, visualizer, tone selection, copy / inject workflows
- **🖥️ Windows desktop HUD**
  - Global hotkey, floating status pill, clipboard-safe injection
- **🧩 Browser extension**
  - Chrome / Edge dictation via WebSocket bridge
- **🛡️ Security hardening**
  - Content Security Policy, security headers, rate limiting, payload limits, XSS sanitization, redacted logging

## 🖼️ Supported Platforms

| Platform | Component |
|---|---|
| Web | Chrome / Edge (Web Speech API + server transcription) |
| Desktop | Windows (C# / .NET Framework 4.5+, Win32 APIs) |
| Extension | Chrome / Edge (Manifest V3) |

## 🏗️ How It Works

Talkity ingests microphone audio → speech-to-text provider → optional AI polish → contextual insertion into the target app or clipboard.

## 🚀 Getting Started

### Prerequisites

- Node.js v16 or higher
- Google Chrome or Microsoft Edge

### 1. Clone the repository

```bash
git clone git@github.com:projectomega2777/talkity.git
cd talkity
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Then set the provider keys you wish to use in `.env`:

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | HTTP port for the standalone server (default `3000`) | No |
| `GROQ_API_KEY` | Groq API key for Whisper transcription / polish (server-side only) | Optional |
| `OPENAI_API_KEY` | OpenAI API key for Whisper transcription / polish (server-side only) | Optional |

### 4. Start the server

```bash
node server.js
```

The server will be accessible at: <http://localhost:3000>

### Desktop application

Build and run the Windows desktop HUD from source using the .NET compiler with the WinForms / Drawing / Speech / WebSocket references.

### Browser extension

Load the extension source (`extension/`) as an unpacked extension in Chrome / Edge and connect it to the Talkity server WebSocket endpoint.

## 🎯 Usage

1. Open the web playground (or launch the desktop HUD / extension).
2. Select a language and start dictation.
3. Speak naturally; the transcript is transcribed and polished.
4. Copy or inject the polished text into your target application.

## 🛡️ Security

Talkity implements defense-in-depth controls including strict HTTP security headers, Content Security Policy, rate limiting, payload size limits, XSS sanitization, and redacted diagnostics.

> **⚠️ Single-tenant deployment only.** All clients authenticate with one shared token (`TALKITY_API_TOKEN`). Every holder of this token must be treated as fully trusted: the architecture provides **no per-user identity, no transcription privacy between token holders, and no tenant isolation**. Authenticated clients can see each other's transcription relays and receive server injection events. Multi-user deployment is unsupported until per-user authentication and authorization are implemented.

## 📦 Third-Party Components

Talkity is a proprietary product. Third-party components used by the product remain subject to their own licenses (e.g., MIT, Apache-2.0, SIL OFL, platform terms).

## 📄 License

Talkity is released as proprietary software. A proprietary license for the Talkity source will be applied as directed by the copyright holder.

## 📬 Support

For support, feedback, or licensing inquiries, please contact the rights holder through the official project channels.
