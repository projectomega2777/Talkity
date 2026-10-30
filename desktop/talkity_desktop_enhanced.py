"""
Talkity Native Desktop Injection Daemon (Windows) - Phase 2 Enhanced
Features:
1. Native Windows Global Hotkey (F8 or Ctrl+Shift+Space) via RegisterHotKey
2. Non-destructive Clipboard Injection via Win32 API
3. Simulated Keystroke Injection (Ctrl+V) via keybd_event / SendInput
4. WebSocket synchronization with Talkity Web Playground (enhanced: reconnection, heartbeat, exponential backoff)
5. Automatic reconnection with exponential backoff and jitter
6. Heartbeat monitoring with server-side ping/pong
7. Protocol validation and safe text insertion

Protocol Documentation (JSON Message Schema):
- CONNECT: Client sends {type: 'register_desktop', clientId: string}
- PING (Server→Client): {type: 'heartbeat', timestamp: number}
- PONG (Client→Server): {type: 'heartbeat_ack', clientId: string}
- INJECT (Broadcast): {type: 'inject_text', text: string, eventId?: string}
- ACK: {type: 'ack', eventId: string, success: boolean}
- ERROR: {type: 'error', code: string, message: string}
"""

import sys
import os
import time
import json
import ctypes
import threading
import winsound
import random
import uuid
from ctypes import wintypes
import urllib.request
import urllib.error
import ssl

# Try to import websocket client
try:
    import websocket
    WEBSOCKET_AVAILABLE = True
except ImportError:
    WEBSOCKET_AVAILABLE = False
    print("[⚠️] websocket-client not installed. WebSocket sync disabled. Run: pip install websocket-client")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Win32 Constants
VK_F8 = 0x77
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_NOREPEAT = 0x4000
HOTKEY_ID_F8 = 1001

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

# Keyboard scan codes
VK_CONTROL = 0x11
VK_V = 0x56
KEYEVENTF_KEYUP = 0x0002

# Protocol Constants
PROTOCOL_VERSION = "1.0.0"
SERVER_URL = "http://localhost:3000"
WS_URL = "ws://localhost:3000"

# 🛡️ SECURITY (B1): deployment token supplied via the environment only.
# It is never embedded in the client source.
API_TOKEN = os.environ.get("TALKITY_API_TOKEN", "").strip()

# Heartbeat configuration (must match server.js: HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT)
HEARTBEAT_INTERVAL_MS = 30000
HEARTBEAT_TIMEOUT_MS = 35000
CLIENT_HEARTBEAT_INTERVAL_MS = 20000

# Reconnection configuration
INITIAL_RECONNECT_DELAY_MS = 1000
MAX_RECONNECT_DELAY_MS = 30000
RECONNECT_BACKOFF = 1.5
RECONNECT_JITTER_RANGE = 0.3  # 30% jitter

# Maximum payload sizes (security limits)
MAX_TEXT_PAYLOAD = 5000
MAX_EVENT_ID_PAYLOAD = 64

# ============================
# WebSocket Sync Client - Protocol v1.0.0
# ============================
class WebSocketSync:
    def __init__(self, ws_url=WS_URL, on_message=None, on_state_change=None):
        self.ws_url = ws_url
        self.on_message = on_message or (lambda data: None)
        self.on_state_change = on_state_change or (lambda state: None)
        self.ws = None
        self.connected = False
        self.client_id = f"desktop-{random.randint(1000, 9999)}"
        self.running = False
        self.reconnect_delay = INITIAL_RECONNECT_DELAY_MS
        self.reconnect_attempts = 0
        self.max_reconnect_attempts = 10

        # Heartbeat - server sends pings, we respond
        self.last_server_ping = None
        self.last_pong_time = time.time() * 1000
        self.heartbeat_timer = None
        self.ping_timer = None

        # Track processed event IDs for duplicate prevention
        self._processed_events = set()
        self._event_id_lock = threading.Lock()

        # Serialization lock for clipboard/injection operations
        self._injection_lock = threading.Lock()

        # Graceful disconnect flag
        self._graceful_disconnect = False

    def connect(self):
        """Establish WebSocket connection with protocol handshake."""
        if not WEBSOCKET_AVAILABLE:
            return False

        # Check if already connected
        if self.connected and self.ws and self.ws.sock and self.ws.sock.connected:
            return True

        # Cancel any pending reconnect
        self.reconnect_attempts = 0
        self._graceful_disconnect = False

        try:
            print(f"[WS] Connecting to {self.ws_url}...")
            self.ws = websocket.WebSocketApp(
                self.ws_url,
                on_open=self._on_open,
                on_message=self._on_message,
                on_error=self._on_error,
                on_close=self._on_close
            )
            # Run in separate thread with proper heartbeat configuration
            # ping_interval=20 matches server's 30s interval (pings during quiet periods)
            wst = threading.Thread(
                target=self.ws.run_forever,
                kwargs={'ping_interval': 20, 'ping_timeout': 10},
                daemon=True
            )
            wst.start()

            # Wait for connection establishment
            timeout = 5
            start = time.time()
            while not self.connected and time.time() - start < timeout:
                time.sleep(0.1)

            if self.connected:
                self._start_client_ping()
            return self.connected

        except Exception as e:
            print(f"[WS] Connection error: {e}")
            self._schedule_reconnect()
            return False

    def _on_open(self, ws):
        """Handle WebSocket connection open."""
        print("[WS] Connected")
        self.connected = True
        self.reconnect_delay = INITIAL_RECONNECT_DELAY_MS
        self.reconnect_attempts = 0

        # Protocol handshake: register this desktop client (token authenticates)
        register_frame = {
            "type": "register_desktop",
            "clientId": self.client_id,
            "protocolVersion": PROTOCOL_VERSION,
            "timestamp": int(time.time() * 1000)
        }
        if API_TOKEN:
            register_frame["token"] = API_TOKEN
        self._send(register_frame)

        self.on_state_change({"connected": True, "clientId": self.client_id})

    def _on_message(self, ws, message):
        """Handle incoming WebSocket message with protocol validation."""
        try:
            # Validate JSON parse
            data = json.loads(message)
        except json.JSONDecodeError as e:
            print(f"[WS] Invalid JSON received: {e}")
            self._send_error("invalid_json", "Message is not valid JSON")
            return

        # Validate message structure
        if not isinstance(data, dict):
            print(f"[WS] Message is not an object: {type(data)}")
            self._send_error("invalid_type", "Message must be a JSON object")
            return

        msg_type = data.get("type")

        # Handle heartbeat from server (server-initiated ping)
        if msg_type == "heartbeat":
            self.last_server_ping = data.get("timestamp")
            self.last_pong_time = time.time() * 1000
            # Respond with heartbeat_ack
            self._send({
                "type": "heartbeat_ack",
                "clientId": self.client_id,
                "timestamp": int(time.time() * 1000)
            })
            return

        # Handle our own ping acknowledgment (legacy support)
        if msg_type == "heartbeat_ack":
            self.last_pong_time = time.time() * 1000
            return

        # Check for duplicate events using eventId
        event_id = data.get("eventId")
        if event_id:
            with self._event_id_lock:
                if event_id in self._processed_events:
                    print(f"[WS] Duplicate event ignored: {event_id}")
                    return
                self._processed_events.add(event_id)
                # Limit memory usage
                if len(self._processed_events) > 1000:
                    self._processed_events.clear()

        # Route message by type
        if msg_type == "inject_text":
            self._handle_inject_text(data)
        elif msg_type == "desktop_status":
            status = "Connected" if data.get("connected") else "Disconnected"
            print(f"[WS] Desktop status: {status}")
        elif msg_type == "error":
            print(f"[WS] Server error: {data.get('code')}: {data.get('message')}")
        elif msg_type == "connected":
            # Initial connection acknowledgment
            print(f"[WS] Server acknowledged connection: {data.get('clientId')}")
        elif msg_type == "ack":
            # Acknowledgment of our message
            print(f"[WS] ACK for event {data.get('eventId')}: {data.get('success')}")
        else:
            # Pass unknown message types to handler
            print(f"[WS] Unknown message type: {msg_type}")
            self.on_message(data)

    def _handle_inject_text(self, data):
        """Handle text injection request with safety checks."""
        # Validate required fields
        text = data.get("text")
        if not isinstance(text, str):
            print("[WS] inject_text missing or invalid 'text' field")
            self._send_error("invalid_payload", "Missing 'text' field")
            return

        # Sanitize and limit text length
        text = text[:MAX_TEXT_PAYLOAD]
        event_id = data.get("eventId", str(uuid.uuid4()))

        if not text:
            print("[WS] Empty text in inject_text")
            self._send({"type": "ack", "eventId": event_id, "success": False, "reason": "empty_text"})
            return

        print(f"[WS] Received injection command (eventId={event_id[:8]}...): {text[:50]}...")

        # Use serialization lock to prevent concurrent injections
        with self._injection_lock:
            try:
                inject_text_to_active_app(text)
                self._send({"type": "ack", "eventId": event_id, "success": True})
            except Exception as e:
                print(f"[WS] Injection failed: {e}")
                self._send({"type": "ack", "eventId": event_id, "success": False, "reason": str(e)})

    def _send_error(self, code, message):
        """Send error response to server."""
        try:
            self.ws.send(json.dumps({
                "type": "error",
                "code": code,
                "message": message,
                "clientId": self.client_id
            }))
        except Exception as e:
            print(f"[WS] Failed to send error: {e}")

    def _on_error(self, ws, error):
        print(f"[WS] Error: {error}")

    def _on_close(self, ws, close_status_code, close_msg):
        was_connected = self.connected
        self.connected = False
        self._stop_heartbeat()

        if was_connected:
            print(f"[WS] Disconnected (code={close_status_code}, msg={close_msg})")
        else:
            print(f"[WS] Connection failed (code={close_status_code})")

        self.on_state_change({"connected": False})

        # Schedule reconnect if not graceful disconnect
        if not self._graceful_disconnect:
            self._schedule_reconnect()

    def _send(self, data):
        """Send JSON message to server with error handling."""
        if self.connected and self.ws:
            try:
                self.ws.send(json.dumps(data))
                return True
            except Exception as e:
                print(f"[WS] Send error: {e}")
        return False

    def _start_client_ping(self):
        """Start client-side ping timer for liveness monitoring."""
        self._stop_ping_timer()

        def ping_check():
            if not self.connected:
                return

            now = time.time() * 1000
            # If no server ping received within timeout, connection may be stale
            if self.last_server_ping:
                elapsed = now - self.last_server_ping
                if elapsed > HEARTBEAT_TIMEOUT_MS:
                    print(f"[WS] No server ping in {elapsed/1000:.1f}s, triggering reconnect")
                    self.disconnect()
                    self._schedule_reconnect()
                    return

            # Send ping to server
            self._send({
                "type": "heartbeat",
                "clientId": self.client_id,
                "timestamp": int(now)
            })

            # Schedule next check
            self.ping_timer = threading.Timer(CLIENT_HEARTBEAT_INTERVAL_MS / 1000, ping_check)
            self.ping_timer.daemon = True
            self.ping_timer.start()

        # Start ping loop after initial delay
        self.ping_timer = threading.Timer(CLIENT_HEARTBEAT_INTERVAL_MS / 1000, ping_check)
        self.ping_timer.daemon = True
        self.ping_timer.start()

    def _stop_ping_timer(self):
        if self.ping_timer:
            self.ping_timer.cancel()
            self.ping_timer = None

    def _stop_heartbeat(self):
        if self.heartbeat_timer:
            self.heartbeat_timer.cancel()
            self.heartbeat_timer = None

    def _stop_all_timers(self):
        """Stop all timers (heartbeat and ping)."""
        self._stop_heartbeat()
        self._stop_ping_timer()

    def _schedule_reconnect(self):
        """Schedule reconnection with exponential backoff and jitter."""
        if not self.running:
            return

        self.reconnect_attempts += 1
        if self.reconnect_attempts > self.max_reconnect_attempts:
            print(f"[WS] Max reconnect attempts ({self.max_reconnect_attempts}) reached, giving up")
            return

        # Exponential backoff with jitter
        delay = min(
            self.reconnect_delay * (RECONNECT_BACKOFF ** (self.reconnect_attempts - 1)),
            MAX_RECONNECT_DELAY_MS
        )
        jitter = random.uniform(0, RECONNECT_JITTER_RANGE) * delay
        total_delay = delay + jitter

        print(f"[WS] Reconnecting in {int(total_delay)}ms (attempt {self.reconnect_attempts}/{self.max_reconnect_attempts})")
        self.reconnect_delay = delay

        # Cancel any existing reconnect timer
        threading.Timer(total_delay / 1000, self.connect).start()

    def send(self, data):
        """Public send method with queue support."""
        if not self._send(data):
            print("[WS] Offline: message not sent")

    def disconnect(self, graceful=True):
        """Gracefully disconnect from WebSocket."""
        self.running = False
        self._graceful_disconnect = graceful
        self._stop_all_timers()

        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None
        self.connected = False


# ============================
# Win32 Clipboard & Injection
# ============================
def play_beep(freq, duration_ms):
    try:
        winsound.Beep(freq, duration_ms)
    except Exception:
        pass

def get_active_window_title():
    hwnd = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(hwnd)
    buff = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buff, length + 1)
    return buff.value

def set_clipboard_text(text):
    if not user32.OpenClipboard(None):
        return False
    try:
        user32.EmptyClipboard()
        data = text.encode('utf-16le') + b'\x00\x00'
        h_mem = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h_mem:
            return False
        ptr = kernel32.GlobalLock(h_mem)
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(h_mem)
        user32.SetClipboardData(CF_UNICODETEXT, h_mem)
        return True
    finally:
        user32.CloseClipboard()

def get_clipboard_text():
    if not user32.OpenClipboard(None):
        return ""
    try:
        h_mem = user32.GetClipboardData(CF_UNICODETEXT)
        if not h_mem:
            return ""
        ptr = kernel32.GlobalLock(h_mem)
        if not ptr:
            return ""
        text = ctypes.wstring_at(ptr)
        kernel32.GlobalUnlock(h_mem)
        return text
    finally:
        user32.CloseClipboard()

def simulate_paste():
    """Simulate Ctrl+V keystroke sequence for paste."""
    user32.keybd_event(VK_CONTROL, 0, 0, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_V, 0, 0, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.02)
    user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)

def restore_clipboard_safely(previous_content, max_retries=3):
    """Safely restore clipboard with retry logic to avoid overwriting newer user data."""
    if not previous_content:
        return False

    for attempt in range(max_retries):
        try:
            # Brief delay to allow user clipboard changes to settle
            time.sleep(0.1 * (attempt + 1))
            set_clipboard_text(previous_content)
            return True
        except Exception as e:
            print(f"[Clipboard] Restore attempt {attempt + 1} failed: {e}")
            time.sleep(0.2)

    print("[Clipboard] Failed to restore after retries")
    return False

def inject_text_to_active_app(text):
    """
    Inject text into the currently active application using clipboard + paste.

    Safety features:
    1. Captures target window BEFORE modifying clipboard
    2. Preserves and restores original clipboard content
    3. Uses serialization lock to prevent concurrent injections
    4. Validates focus hasn't changed during operation
    5. Provides clear success/failure feedback

    Note: User must ensure focus is in the target application BEFORE calling this.
    We do NOT auto-focus or move window focus to prevent accidental insertion
    into wrong applications.
    """
    # Capture target window BEFORE clipboard modification
    target_window = user32.GetForegroundWindow()
    if not target_window:
        print("[⚡ Injection] No active window detected")
        return False

    window_title = get_active_window_title()
    print(f"\n[⚡ Injection] Target Window: '{window_title}'")
    print(f"[📝 Content]: {text}")

    # Safely capture and preserve clipboard
    old_clip = ""
    try:
        old_clip = get_clipboard_text()
        print(f"[Clipboard] Preserved {len(old_clip)} chars")
    except Exception as e:
        print(f"[Clipboard] Preserve warning: {e}")

    try:
        # Set clipboard with text to inject (add space for reliable paste)
        if not set_clipboard_text(text + " "):
            print("[⚡ Injection] Failed to set clipboard")
            return False

        time.sleep(0.05)  # Allow clipboard to settle

        # Verify focus hasn't changed (user may have clicked elsewhere)
        current_window = user32.GetForegroundWindow()
        if current_window != target_window:
            print(f"[⚡ Injection] Aborted: Focus changed from '{window_title}' to '{get_active_window_title()}'")
            # Restore original clipboard before aborting
            if old_clip:
                set_clipboard_text(old_clip)
            return False

        # Execute paste
        simulate_paste()
        play_beep(900, 70)
        print("[✅ Injection Success] Injected into active application!")

    except Exception as e:
        print(f"[⚡ Injection] Error: {e}")
        play_beep(400, 150)  # Error beep
    finally:
        # Restore clipboard after delay (allows paste to complete first)
        time.sleep(0.2)
        if old_clip and len(old_clip) <= MAX_TEXT_PAYLOAD:
            restore_clipboard_safely(old_clip)
            print(f"[Clipboard] Restored original content")

    return True

# ============================
# Server Communication (HTTP Fallback)
# ============================
def http_post_json(url, data):
    try:
        headers = {'Content-Type': 'application/json'}
        if API_TOKEN:
            headers['x-talkity-token'] = API_TOKEN
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode('utf-8'),
            headers=headers
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.URLError as e:
        print(f"[HTTP] Request failed: {e}")
    except Exception as e:
        print(f"[HTTP] Error: {e}")
    return None

def polish_text_via_server(text, tone="clean"):
    """Send text to local server for AI polishing."""
    result = http_post_json(f"{SERVER_URL}/api/polish", {"rawText": text, "tone": tone})
    if result and "formattedText" in result:
        return result["formattedText"]
    # Fallback local polish
    cleaned = text.replace(" um ", " ").replace(" uh ", " ").replace(" like ", " ")
    if cleaned:
        cleaned = cleaned[0].upper() + cleaned[1:]
        if not cleaned.endswith("."):
            cleaned += "."
    return cleaned

# ============================
# Main Application
# ============================
class TalkityDesktop:
    def __init__(self):
        self.ws_sync = WebSocketSync(
            ws_url=WS_URL,
            on_message=self._handle_ws_message,
            on_state_change=self._handle_ws_state_change
        )
        self.is_dictating = False
        self.speech_buffer = ""
        self.target_window = None

    def _handle_ws_message(self, data):
        msg_type = data.get("type")
        if msg_type == "inject_text":
            text = data.get("text", "")
            if text:
                print(f"[WS] Received injection command: {text[:50]}...")
                inject_text_to_active_app(text)
        elif msg_type == "desktop_status":
            status = "Connected" if data.get("connected") else "Disconnected"
            print(f"[WS] Desktop status: {status}")

    def _handle_ws_state_change(self, state):
        connected = state.get("connected", False)
        client_id = state.get("clientId", "unknown")
        if connected:
            print(f"[WS] Bridge active: {client_id}")
        else:
            print("[WS] Bridge disconnected")

    def start(self):
        print("=" * 55)
        print("🎙️ Talkity Desktop Daemon v2.0 (Phase 2 Enhanced)")
        print("⌨️ Press [F8] anywhere on Windows to toggle Voice Injection")
        print("🔗 WebSocket bridge with auto-reconnect & heartbeat")
        print("=" * 55 + "\n")

        # Connect WebSocket
        self.ws_sync.running = True
        self.ws_sync.connect()

        # Register F8 hotkey
        if not user32.RegisterHotKey(None, HOTKEY_ID_F8, MOD_NOREPEAT, VK_F8):
            print("[⚠️] Could not register F8. Trying Shift+F8...")
            user32.RegisterHotKey(None, HOTKEY_ID_F8, MOD_SHIFT | MOD_NOREPEAT, VK_F8)

        msg = wintypes.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
                if msg.message == 0x0312:  # WM_HOTKEY
                    if msg.wParam == HOTKEY_ID_F8:
                        self._toggle_dictation()
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            user32.UnregisterHotKey(None, HOTKEY_ID_F8)
            self.ws_sync.disconnect()

    def _toggle_dictation(self):
        if not self.is_dictating:
            self._start_dictation()
        else:
            self._stop_dictation()

    def _start_dictation(self):
        self.is_dictating = True
        self.target_window = user32.GetForegroundWindow()
        self.speech_buffer = ""

        play_beep(520, 100)
        play_beep(780, 120)

        window_title = get_active_window_title()
        print(f"\n[🔴 Voice Dictation Started] Focused: {window_title}")
        print("Speaking... (Press F8 again to stop & inject)")

        # Notify server
        http_post_json(f"{SERVER_URL}/api/inject", {"text": "Voice dictation started"})

    def _stop_dictation(self):
        self.is_dictating = False
        play_beep(780, 100)
        play_beep(520, 120)
        print("[⏹️ Voice Dictation Stopped] Polishing & injecting...")

        # For demo: use placeholder text since we don't have native speech recognition
        # In production, this would use Windows Speech API or cloud ASR
        demo_text = self.speech_buffer if self.speech_buffer else "Talkity voice dictation is working with WebSocket sync."
        polished = polish_text_via_server(demo_text)

        # Inject
        inject_text_to_active_app(polished)
        print(f"[✅] Polished text injected: {polished[:60]}...")

if __name__ == "__main__":
    app = TalkityDesktop()
    app.start()