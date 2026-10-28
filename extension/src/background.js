// Talkity Chrome Extension - Background Service Worker
// Manages WebSocket connection to the Talkity server and relays commands/transcriptions.
// Protocol: Talkity WebSocket Protocol v1.0.0 (see PROTOCOL_SPEC.md)

// ---------------------------------------------------------------------------
// Connection configuration
// ---------------------------------------------------------------------------
// Production endpoint verified against server.js: a `ws` WebSocketServer is
// mounted with no explicit `path` option, so it serves at the root "/".
// Render serves it over TLS, hence wss://.
const PRODUCTION_WS_URL = 'wss://talkity-qifh.onrender.com/';

// Client heartbeat cadence (PROTOCOL_SPEC.md: client ping every 20 000 ms).
const CLIENT_HEARTBEAT_INTERVAL_MS = 20000;

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;

// Last known connection state, surfaced to the popup on demand.
let connectionState = {
  connected: false,
  url: PRODUCTION_WS_URL,
  reconnectAttempts: 0
};

function connectWebSocket() {
  const serverUrl = PRODUCTION_WS_URL;
  connectionState.url = serverUrl;
  console.log('[Talkity Background] Connecting to', serverUrl);

  try {
    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
      reconnectAttempts = 0;
      connectionState.connected = true;
      connectionState.reconnectAttempts = 0;
      console.log('[Talkity Background] Connected to server:', serverUrl);

      // Register extension as a client (Protocol v1.0.0)
      ws.send(JSON.stringify({
        type: 'register_extension',
        clientId: 'ext-' + Math.random().toString(36).substring(2, 10),
        protocolVersion: '1.0.0',
        timestamp: Date.now()
      }));

      // Start client heartbeat cycle (client ping every 20 s per spec)
      startClientHeartbeat();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Server heartbeat ping -> acknowledge (keeps us alive)
        if (data.type === 'heartbeat') {
          ws.send(JSON.stringify({
            type: 'heartbeat_ack',
            clientId: 'ext-client',
            timestamp: Date.now()
          }));
          return;
        }

        if (data.type === 'extension_registered') {
          console.log('[Talkity Background] Server confirmed extension registration');
          return;
        }

        if (data.type === 'desktop_status') {
          console.log('[Talkity Background] Desktop status:', data.connected);
          return;
        }

        if (data.type === 'inject_text') {
          // Forward text injection to active tab
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                action: 'talkity_inject',
                text: data.text
              });
            }
          });
          return;
        }
      } catch (err) {
        console.warn('[Talkity Background] Message parse error:', err.message);
      }
    };

    ws.onclose = (event) => {
      connectionState.connected = false;
      console.log('[Talkity Background] WebSocket closed (code=' + event.code + '). Reconnecting...');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      // Log the error type only; never log URLs/credentials/secrets.
      connectionState.connected = false;
      console.warn('[Talkity Background] WebSocket error:', err.message || 'unknown');
    };

  } catch (e) {
    console.warn('[Talkity Background] Connection failed:', e.message);
    scheduleReconnect();
  }
}

let heartbeatTimer = null;

function startClientHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'heartbeat',
          clientId: 'ext-client',
          timestamp: Date.now()
        }));
      } catch (e) {
        console.warn('[Talkity Background] Heartbeat send failed:', e.message);
      }
    }
  }, CLIENT_HEARTBEAT_INTERVAL_MS);
}

function stopClientHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  stopClientHeartbeat();
  const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  connectionState.reconnectAttempts = reconnectAttempts;
  console.log('[Talkity Background] Reconnecting in', delay, 'ms (attempt', reconnectAttempts + ')');
  setTimeout(connectWebSocket, delay);
}

// Initialize connection on startup
connectWebSocket();

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'get_connection_status') {
    sendResponse({
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      url: connectionState.url,
      reconnectAttempts: connectionState.reconnectAttempts
    });
  } else if (request.action === 'send_transcription') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Never echo dictated text into console logs.
      ws.send(JSON.stringify({
        type: 'transcription',
        text: request.text,
        tone: request.tone || 'clean',
        timestamp: Date.now()
      }));
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not connected to server' });
    }
  } else if (request.action === 'reload_connection') {
    // Popup requested a reconnect.
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    reconnectAttempts = 0;
    connectWebSocket();
    sendResponse({ success: true });
  }
  return true;
});
