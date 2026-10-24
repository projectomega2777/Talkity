# Talkity WebSocket Protocol Specification v1.0.0

Source of truth: `server.js` lines 220–354, `desktop/talkity_desktop_enhanced.py`, `desktop/test_protocol.py`.

---

## Endpoint

```
ws://localhost:3000
```

---

## Connection Sequence

1. Server sends `connected` immediately on WebSocket accept.
2. Client sends `register_desktop` to identify itself.
3. Both sides start heartbeat cycle.

---

## Message Schemas

### Server → Client

| Message | Fields |
|---------|--------|
| `connected` | `{type, message: string, clientId: string, serverTime: string}` |
| `heartbeat` | `{type, timestamp: number}` — server ping every **30 000 ms** |
| `inject_text` | `{type, text: string, eventId?: string}` — broadcast to all clients |
| `heartbeat_ack` | `{type, timestamp: number}` — response to client ping |
| `desktop_status` | `{type, connected: boolean, clientId?: string}` |
| `error` | `{type, code: string, message: string}` |
| `ack` | `{type, eventId: string, success: boolean, reason?: string}` |
| `history_update` | `{type, entry: object}` |
| `history_cleared` | `{type}` |

### Client → Server

| Message | Fields |
|---------|--------|
| `register_desktop` | `{type, clientId: string, protocolVersion: "1.0.0", timestamp: number}` |
| `heartbeat` | `{type, clientId: string, timestamp: number}` — client ping every **20 000 ms** |
| `heartbeat_ack` | `{type, clientId: string, timestamp: number}` — response to server ping |
| `ack` | `{type, eventId: string, success: boolean, reason?: string}` — after inject_text |
| `error` | `{type, code: string, message: string, clientId: string}` |

---

## Heartbeat Protocol

| Parameter | Value | Source |
|-----------|-------|--------|
| Server ping interval | 30 000 ms | `server.js:221 HEARTBEAT_INTERVAL` |
| Server dead timeout | 35 000 ms | `server.js:222 HEARTBEAT_TIMEOUT` |
| Client ping interval | 20 000 ms | Python: `CLIENT_HEARTBEAT_INTERVAL_MS` |
| Client timeout trigger | 35 000 ms | Python: `HEARTBEAT_TIMEOUT_MS` |

Server sends `{type:"heartbeat", timestamp:N}` every 30 s via JSON **and** WebSocket ping frame.  
Client responds with `{type:"heartbeat_ack", clientId:..., timestamp:N}`.  
Client also sends its own `{type:"heartbeat"}` every 20 s.  
If client receives no server ping for 35 s, it closes and reconnects.

---

## Reconnection

| Parameter | Value |
|-----------|-------|
| Initial delay | 1 000 ms |
| Backoff multiplier | 1.5× |
| Max delay | 30 000 ms |
| Jitter | 0 – 30% of delay |
| Max attempts | 10 |

---

## Payload Limits

| Field | Limit |
|-------|-------|
| `text` in `inject_text` | 5 000 chars |
| `eventId` | 64 chars |
| `inject_text` duplicate window | 1 000 event IDs (then clear) |

---

## Security

- No API keys, secrets, or dictated text content in log output.
- Payload length validated and truncated before processing.
- All sends serialized; no concurrent WebSocket writes.
- Clipboard lock prevents concurrent injection.
- Focus validation: abort paste if foreground window changed.

---

## Build Commands

### C# HUD client

```powershell
# Requires .NET Framework 4.5+ (ClientWebSocket needs 4.5; original used 4.0)
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:winexe ^
  /out:Talkity.exe ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:System.Speech.dll ^
  /r:System.Net.dll ^
  desktop/TalkityApp.cs

# OR with .NET Framework 4.5 csc:
# %ProgramFiles(x86)%\MSBuild\14.0\Bin\csc.exe ... same flags
```

> **Note:** `System.Net.WebSockets.ClientWebSocket` requires .NET 4.5+.
> The `v4.0.30319` csc.exe targets .NET 4.5 on machines that have 4.5 installed.
> Verify with: `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe -version`

### C# Tests (standalone — no test framework)

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /out:TalkityTests.exe ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:System.Speech.dll ^
  desktop/TalkityTests.cs

TalkityTests.exe
```

### Python protocol tests

```bash
python -m unittest desktop.test_protocol
# or: py desktop/test_protocol.py
```

### Node backend tests

```bash
node test.js
```

---

## Manual Windows Integration Checklist

1. Start server: `node server.js`
2. Open Notepad (or any text editor).
3. Build and launch `Talkity.exe`.
4. Press **F8** — HUD dot turns red, dictate a sentence, press **F8** again.
   - Verify text appears in Notepad.
   - Verify clipboard is restored to its prior value after ~300 ms.
5. Open `http://localhost:3000` and use the web polish → send to desktop.
   - In the web app, polish a phrase; the server broadcasts `inject_text`.
   - Verify HUD injects it into the last focused window.
6. Kill `node server.js` while HUD is running.
   - Verify HUD reconnects automatically within 1–30 s (exponential backoff).
   - Restart server; verify HUD re-registers.
7. Trigger two rapid injections of the same `eventId`.
   - Verify text appears once, not twice.
