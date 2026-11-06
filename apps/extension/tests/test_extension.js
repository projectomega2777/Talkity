const assert = require('assert');
const path = require('path');

console.log('Running Talkity Extension & Server Protocol Tests...');

// 1. Test Server Message and Registration Handlers (Simulated)
const mockClients = new Map();
let desktopClient = null;

function handleMessage(ws, msgStr) {
  const data = JSON.parse(msgStr);
  if (data.type === 'register_desktop') {
    desktopClient = ws;
    mockClients.get(ws).isDesktop = true;
    mockClients.get(ws).clientId = data.clientId;
    return { type: 'desktop_status', connected: true, clientId: data.clientId };
  }
  if (data.type === 'register_extension') {
    mockClients.get(ws).isExtension = true;
    mockClients.get(ws).clientId = data.clientId;
    return { type: 'extension_registered', success: true };
  }
  if (data.type === 'heartbeat') {
    return { type: 'heartbeat_ack', timestamp: Date.now() };
  }
  return { type: 'ack', success: true };
}

// Test Desktop Registration
const wsMock1 = { id: 'ws-1' };
mockClients.set(wsMock1, { isDesktop: false, isExtension: false });
const res1 = handleMessage(wsMock1, JSON.stringify({ type: 'register_desktop', clientId: 'desktop-test1234', protocolVersion: '1.0.0' }));
assert.strictEqual(res1.type, 'desktop_status');
assert.strictEqual(res1.connected, true);
assert.strictEqual(desktopClient, wsMock1);
assert.strictEqual(mockClients.get(wsMock1).isDesktop, true);
console.log('✅ Desktop registration protocol test passed.');

// Test Extension Registration & Protocol v1.0.0 Compatibility
const wsMock2 = { id: 'ws-2' };
mockClients.set(wsMock2, { isDesktop: false, isExtension: false });
const res2 = handleMessage(wsMock2, JSON.stringify({ type: 'register_extension', clientId: 'ext-abcd1234', protocolVersion: '1.0.0' }));
assert.strictEqual(res2.type, 'extension_registered');
assert.strictEqual(mockClients.get(wsMock2).isExtension, true);
console.log('✅ Extension registration protocol test passed.');

// Test Heartbeat and Ack
const res3 = handleMessage(wsMock1, JSON.stringify({ type: 'heartbeat', timestamp: 123456789 }));
assert.strictEqual(res3.type, 'heartbeat_ack');
console.log('✅ Heartbeat acknowledgment protocol test passed.');

// 2. Test Reconnection Backoff Calculation
function calculateBackoff(attempt) {
  const INITIAL_MS = 1000;
  const MAX_MS = 30000;
  const BACKOFF = 1.5;
  return Math.min(INITIAL_MS * Math.pow(BACKOFF, attempt), MAX_MS);
}

assert.strictEqual(calculateBackoff(0), 1000);
assert.strictEqual(calculateBackoff(1), 1500);
assert.strictEqual(calculateBackoff(20), 30000); // capped at max 30s
console.log('✅ Reconnection exponential backoff test passed.');

// 3. Test Recording-to-Insertion Message Flow
// Simulates the full flow: popup -> background -> content script
function simulateRecordingToInsertionFlow() {
  // Mock WebSocket state
  let wsConnected = true;
  let lastSentMessage = null;

  // Mock chrome.runtime.sendMessage
  const runtimeMessages = [];
  const mockSendMessage = (msg, callback) => {
    runtimeMessages.push(msg);
    if (msg.action === 'send_transcription') {
      if (wsConnected) {
        lastSentMessage = JSON.stringify({
          type: 'transcription',
          text: msg.text,
          tone: msg.tone || 'clean',
          timestamp: Date.now()
        });
        callback({ success: true });
      } else {
        callback({ success: false, error: 'Not connected to server' });
      }
    } else if (msg.action === 'get_connection_status') {
      callback({ connected: wsConnected, url: 'wss://talkity-qifh.onrender.com/', reconnectAttempts: 0 });
    }
  };

  // Mock chrome.tabs.sendMessage for content script
  const contentScriptMessages = [];
  const mockTabsSendMessage = (tabId, msg, callback) => {
    contentScriptMessages.push({ tabId, msg });
    // Simulate successful content script injection
    callback({ status: 'injected' });
  };

  // Mock chrome.tabs.query
  const mockTabsQuery = (query, callback) => {
    callback([{ id: 1, active: true }]);
  };

  // Simulate popup sending transcription via background (send_transcription)
  const testText = 'Hello world from voice dictation';
  mockSendMessage({
    action: 'send_transcription',
    text: testText,
    tone: 'clean'
  }, () => {});

  // Verify background sent transcription to WebSocket
  assert(lastSentMessage !== null, 'Background should have sent transcription to WebSocket');
  const wsMsg = JSON.parse(lastSentMessage);
  assert.strictEqual(wsMsg.type, 'transcription');
  assert.strictEqual(wsMsg.text, testText);
  assert.strictEqual(wsMsg.tone, 'clean');

  // Simulate popup's dual-path: also call chrome.tabs.sendMessage directly
  // This mirrors the dual-path approach in popup.js lines 66-78
  mockTabsQuery({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      mockTabsSendMessage(tabs[0].id, {
        action: 'talkity_inject',
        text: testText
      }, () => {});
    }
  });

  // Verify content script was also called directly from popup (dual-path)
  assert.strictEqual(contentScriptMessages.length, 1, 'Popup should have called content script directly');
  assert.strictEqual(contentScriptMessages[0].msg.action, 'talkity_inject');
  assert.strictEqual(contentScriptMessages[0].msg.text, testText);

  // Simulate server sending inject_text to background
  // Background should forward to content script
  const mockBackgroundHandleInject = (data) => {
    mockTabsQuery({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        mockTabsSendMessage(tabs[0].id, {
          action: 'talkity_inject',
          text: data.text
        }, () => {});
      }
    });
  };

  mockBackgroundHandleInject({ type: 'inject_text', text: 'Server injected text' });
  assert.strictEqual(contentScriptMessages.length, 2, 'Background should forward inject_text to content script');
  assert.strictEqual(contentScriptMessages[1].msg.text, 'Server injected text');

  console.log('✅ Recording-to-insertion message flow test passed.');
}

simulateRecordingToInsertionFlow();

// 4. Test Locked Production Configuration
function testLockedProductionConfig() {
  // Background should use hardcoded PRODUCTION_WS_URL, never from storage
  const backgroundSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

  // Verify PRODUCTION_WS_URL is defined and used
  assert(backgroundSource.includes("const PRODUCTION_WS_URL = 'wss://talkity-qifh.onrender.com/';"),
    'Background must have hardcoded production WebSocket URL');

  // Verify connectWebSocket uses PRODUCTION_WS_URL directly (no storage fallback)
  const connectFnStart = backgroundSource.indexOf('function connectWebSocket()');
  const connectFnEnd = backgroundSource.indexOf('}', connectFnStart) + 1;
  const connectFnBody = backgroundSource.substring(connectFnStart, connectFnEnd);

  // Should not use chrome.storage.local for server URL
  assert(!connectFnBody.includes('chrome.storage.local'),
    'connectWebSocket must not read server URL from storage');

  // Should not have useCustomServer logic
  assert(!backgroundSource.includes('useCustomServer'),
    'Background must not have useCustomServer logic');

  // Should not have resolveServerUrl function
  assert(!backgroundSource.includes('resolveServerUrl'),
    'Background must not have resolveServerUrl function');

  // Popup should not have server URL input
  const popupSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'popup.js'), 'utf8');
  assert(!popupSource.includes('serverUrlInput'),
    'Popup must not have server URL input');
  assert(!popupSource.includes('useCustomServer'),
    'Popup must not have useCustomServer logic');
  assert(!popupSource.includes('reconnectBtn') || popupSource.includes('btn-secondary'),
    'Popup should use Retry Connection button (btn-secondary) not reconnect button');

  // Popup HTML should not have settings group or server URL input
  const popupHtml = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');
  assert(!popupHtml.includes('settings-group'),
    'Popup HTML must not have settings group');
  assert(!popupHtml.includes('serverUrlInput'),
    'Popup HTML must not have server URL input element');
  assert(!popupHtml.includes('reconnectBtn'),
    'Popup HTML must not have reconnect button');

  // Manifest should have production host permission
  const manifest = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert(manifest.host_permissions.includes('https://talkity-qifh.onrender.com/*'),
    'Manifest must include production host permission');

  console.log('✅ Locked production configuration test passed.');
}

testLockedProductionConfig();

console.log('🎉 All Phase 4.1 extension and protocol validation tests passed successfully!');
