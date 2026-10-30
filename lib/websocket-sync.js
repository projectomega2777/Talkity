/**
 * Talkity WebSocket Synchronization Module
 * Handles reconnection logic, heartbeat monitoring, and desktop-web bridge
 * Used by: server.js (server-side), desktop clients (via HTTP bridge)
 */

class WebSocketSync {
  constructor(serverUrl = 'http://localhost:3000', options = {}) {
    this.serverUrl = serverUrl;
    this.wsUrl = serverUrl.replace(/^http/, 'ws');
    this.ws = null;
    this.connected = false;
    this.clientId = `desktop-${Math.random().toString(36).substr(2, 9)}`;
    // 🛡️ SECURITY (B1): optional deployment token, supplied by the caller
    // (from its environment), included in the first register frame.
    this.token = typeof options.token === 'string' ? options.token : '';

    // Reconnection strategy
    this.reconnectDelay = options.initialDelay || 1000; // ms
    this.maxReconnectDelay = options.maxDelay || 30000; // ms
    this.reconnectBackoffMultiplier = options.backoff || 1.5;
    this.maxReconnectAttempts = options.maxAttempts || Infinity;
    this.reconnectAttempts = 0;

    // Heartbeat monitoring
    this.heartbeatInterval = options.heartbeatInterval || 30000; // ms
    this.heartbeatTimeout = options.heartbeatTimeout || 5000; // ms
    this.heartbeatTimer = null;
    this.heartbeatAckTimer = null;
    this.missedHeartbeats = 0;
    this.maxMissedHeartbeats = 3;

    // Callbacks
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onError = options.onError || (() => {});
    this.onStateChange = options.onStateChange || (() => {});

    // Message queue for offline buffering
    this.messageQueue = [];
    this.maxQueueSize = options.maxQueueSize || 100;
  }

  connect() {
    if (this.connected || this.ws?.readyState === WebSocket.OPEN) {
      console.warn('[WebSocketSync] Already connected');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const err = `[WebSocketSync] Max reconnection attempts (${this.maxReconnectAttempts}) reached`;
      console.error(err);
      this.onError(new Error(err));
      return;
    }

    try {
      console.log(`[WebSocketSync] Connecting to ${this.wsUrl} (attempt ${this.reconnectAttempts + 1})...`);
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onerror = (event) => this.handleError(event);
      this.ws.onclose = () => this.handleClose();
    } catch (err) {
      console.error('[WebSocketSync] Connection error:', err.message);
      this.scheduleReconnect();
    }
  }

  handleOpen() {
    console.log('[WebSocketSync] Connected');
    this.connected = true;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000; // Reset backoff
    this.missedHeartbeats = 0;

    // Register this client with the server (token authenticates when set)
    const registerFrame = {
      type: 'register_desktop',
      clientId: this.clientId,
      timestamp: Date.now()
    };
    if (this.token) registerFrame.token = this.token;
    this.send(registerFrame);

    // Flush queued messages
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      this.send(msg);
    }

    this.startHeartbeat();
    this.onConnect({ clientId: this.clientId });
    this.onStateChange({ connected: true, clientId: this.clientId });
  }

  handleMessage(event) {
    try {
      const data = JSON.parse(event.data);

      // Handle server heartbeat response
      if (data.type === 'heartbeat_ack') {
        clearTimeout(this.heartbeatAckTimer);
        this.missedHeartbeats = 0;
        return;
      }

      // Handle server heartbeat request
      if (data.type === 'heartbeat') {
        this.sendRaw(JSON.stringify({ type: 'heartbeat_ack', clientId: this.clientId }));
        return;
      }

      this.onMessage(data);
    } catch (err) {
      console.error('[WebSocketSync] Message parse error:', err.message);
      this.onError(err);
    }
  }

  handleError(event) {
    console.error('[WebSocketSync] WebSocket error:', event);
    this.onError(new Error(`WebSocket error: ${event.type}`));
  }

  handleClose() {
    console.log('[WebSocketSync] Disconnected');
    this.connected = false;
    this.ws = null;
    this.stopHeartbeat();
    this.onDisconnect();
    this.onStateChange({ connected: false });
    this.scheduleReconnect();
  }

  send(data) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(JSON.stringify(data));
    } else {
      // Buffer message for later delivery
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push(data);
        console.warn(`[WebSocketSync] Offline: buffered message (queue: ${this.messageQueue.length})`);
      } else {
        console.warn('[WebSocketSync] Message queue full; discarding oldest message');
        this.messageQueue.shift();
        this.messageQueue.push(data);
      }
    }
  }

  sendRaw(jsonString) {
    try {
      this.ws?.send(jsonString);
    } catch (err) {
      console.error('[WebSocketSync] Send error:', err.message);
      this.onError(err);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) {
        this.stopHeartbeat();
        return;
      }

      this.sendRaw(JSON.stringify({ type: 'heartbeat', clientId: this.clientId }));

      // Set a timeout waiting for heartbeat_ack
      this.heartbeatAckTimer = setTimeout(() => {
        this.missedHeartbeats++;
        console.warn(`[WebSocketSync] Heartbeat timeout (missed: ${this.missedHeartbeats})`);

        if (this.missedHeartbeats >= this.maxMissedHeartbeats) {
          console.error('[WebSocketSync] Too many missed heartbeats; disconnecting');
          this.disconnect();
          this.scheduleReconnect();
        }
      }, this.heartbeatTimeout);
    }, this.heartbeatInterval);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.heartbeatAckTimer);
    this.heartbeatTimer = null;
    this.heartbeatAckTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WebSocketSync] Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(this.reconnectBackoffMultiplier, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;
    console.log(`[WebSocketSync] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    console.log('[WebSocketSync] Disconnecting');
    this.stopHeartbeat();
    this.messageQueue = [];
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  getState() {
    return {
      connected: this.connected,
      clientId: this.clientId,
      reconnectAttempts: this.reconnectAttempts,
      queuedMessages: this.messageQueue.length,
      missedHeartbeats: this.missedHeartbeats
    };
  }

  isHealthy() {
    return this.connected && this.missedHeartbeats < this.maxMissedHeartbeats;
  }
}

// Export for Node.js (server-side)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebSocketSync;
}
