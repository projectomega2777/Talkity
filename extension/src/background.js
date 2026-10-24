// Talkity Chrome Extension - Background Service Worker
// Manages WebSocket connection to Talkity server and relays commands/transcriptions.

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;

function connectWebSocket() {
  chrome.storage.local.get(['serverUrl'], (result) => {
    const serverUrl = result.serverUrl || 'ws://localhost:3000';

    try {
      ws = new WebSocket(serverUrl);

      ws.onopen = () => {
        reconnectAttempts = 0;
        console.log('[Talkity Background] Connected to server:', serverUrl);

        // Register extension as a client
        ws.send(JSON.stringify({
          type: 'register_extension',
          clientId: 'ext-' + Math.random().toString(36).substring(2, 10),
          protocolVersion: '1.0.0',
          timestamp: Date.now()
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'heartbeat') {
            ws.send(JSON.stringify({
              type: 'heartbeat_ack',
              clientId: 'ext-client',
              timestamp: Date.now()
            }));
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
          }
        } catch (err) {
          console.warn('[Talkity Background] Message parse error:', err);
        }
      };

      ws.onclose = () => {
        console.log('[Talkity Background] WebSocket closed. Reconnecting...');
        scheduleReconnect();
      };

      ws.onerror = (err) => {
        console.warn('[Talkity Background] WebSocket error:', err);
      };

    } catch (e) {
      console.warn('[Talkity Background] Connection failed:', e);
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  setTimeout(connectWebSocket, delay);
}

// Initialize connection on startup
connectWebSocket();

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get_connection_status') {
    sendResponse({ connected: ws && ws.readyState === WebSocket.OPEN });
  } else if (request.action === 'send_transcription') {
    if (ws && ws.readyState === WebSocket.OPEN) {
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
  }
  return true;
});
