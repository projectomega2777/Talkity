// Talkity Client-Side Application Logic

(function () {
  'use strict';

  // State Management
  const state = {
    isRecording: false,
    startTime: 0,
    timerInterval: null,
    audioContext: null,
    analyser: null,
    mediaStream: null,
    recognition: null,
    rawText: '',
    interimText: '',
    polishedText: '',
    currentTone: 'clean',
    currentApp: 'slack',
    dictionary: [],
    settings: {
      engine: 'webspeech',
      apiToken: '',
      autoCopy: true,
      soundChimes: true
    },
    ws: null
  };

  // DOM Elements
  const recordBtn = document.getElementById('recordBtn');
  const recordBtnText = document.getElementById('recordBtnText');
  const hudCapsule = document.getElementById('hudCapsule');
  const capsuleDot = document.getElementById('capsuleDot');
  const capsuleLabel = document.getElementById('capsuleLabel');
  const capsuleTimer = document.getElementById('capsuleTimer');
  const capsuleWaveform = document.getElementById('capsuleWaveform');
  const mainVisualizer = document.getElementById('mainVisualizer');
  const visualizerGlow = document.getElementById('visualizerGlow');
  const rawTextDisplay = document.getElementById('rawTextDisplay');
  const polishedTextDisplay = document.getElementById('polishedTextDisplay');
  const rawMeta = document.getElementById('rawMeta');
  const polishLatencyBadge = document.getElementById('polishLatencyBadge');
  const copyBtn = document.getElementById('copyBtn');
  const injectActiveAppBtn = document.getElementById('injectActiveAppBtn');
  const tonePills = document.querySelectorAll('.tone-pill');
  const appTabs = document.querySelectorAll('.app-tab');
  const insertToSandboxBtn = document.getElementById('insertToSandboxBtn');
  const dictForm = document.getElementById('dictForm');
  const dictTableBody = document.getElementById('dictTableBody');
  const historyTableBody = document.getElementById('historyTableBody');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const sttEngineSelect = document.getElementById('sttEngineSelect');
  const apiTokenInput = document.getElementById('apiTokenInput');
  const autoCopyCheck = document.getElementById('autoCopyCheck');
  const soundChimesCheck = document.getElementById('soundChimesCheck');
  const daemonStatus = document.getElementById('daemonStatus');

  // Canvas contexts
  const mainCtx = mainVisualizer.getContext('2d');
  const capsuleCtx = capsuleWaveform.getContext('2d');

  // Initialize
  async function init() {
    loadSettings();
    initWebSocket();
    initSpeechRecognition();
    fetchDictionary();
    await clearHistoryAndResetPage();
    attachEventListeners();
    setupCanvasAnimation();
  }

  // Load / Save Settings
  function loadSettings() {
    try {
      const saved = localStorage.getItem('talkity_settings');
      if (saved) {
        state.settings = { ...state.settings, ...JSON.parse(saved) };
      }
    } catch {}

    sttEngineSelect.value = state.settings.engine;
    apiTokenInput.value = state.settings.apiToken || '';
    autoCopyCheck.checked = state.settings.autoCopy;
    soundChimesCheck.checked = state.settings.soundChimes;
  }

  function saveSettings() {
    state.settings.engine = sttEngineSelect.value;
    state.settings.apiToken = apiTokenInput.value.trim();
    state.settings.autoCopy = autoCopyCheck.checked;
    state.settings.soundChimes = soundChimesCheck.checked;

    localStorage.setItem('talkity_settings', JSON.stringify(state.settings));
    settingsModal.classList.remove('open');
    showToast('Settings saved successfully');
  }

  // Audio Feedback Synthesizer (Chimes)
  function playChime(type) {
    if (!state.settings.soundChimes) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === 'start') {
        // Gentle rising chime
        osc.frequency.setValueAtTime(480, now);
        osc.frequency.exponentialRampToValueAtTime(720, now + 0.12);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
      } else {
        // Soft descending chime
        osc.frequency.setValueAtTime(680, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.14);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      }
    } catch {}
  }

  // WebSocket Connection (Phase 2: Enhanced Reconnection)
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return; // Already connected or connecting
    }

    try {
      state.ws = new WebSocket(wsUrl);
      state.reconnectDelay = state.reconnectDelay || 1000;

      state.ws.onopen = () => {
        state.reconnectDelay = 1000; // Reset backoff on successful connect
        daemonStatus.querySelector('.status-dot').style.background = '#10b981';
        daemonStatus.querySelector('.status-label').textContent = 'Desktop Bridge Connected';
        // 🛡️ SECURITY (B1): authenticate the WS connection when a token is
        // configured. Local development (no token, loopback) is bypassed
        // server-side.
        if (state.settings.apiToken) {
          try {
            state.ws.send(JSON.stringify({ type: 'auth', token: state.settings.apiToken }));
          } catch {}
        }
      };

      state.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'heartbeat') {
            // Respond with acknowledgment
            state.ws.send(JSON.stringify({ type: 'heartbeat_ack', clientId: state.clientId || 'web-client' }));
            return;
          }
          if (data.type === 'heartbeat_ack') {
            // Server heartbeat confirmed
            return;
          }
          if (data.type === 'remote_dictation_toggle') {
            toggleRecording();
          } else if (data.type === 'history_update') {
            fetchHistory();
          } else if (data.type === 'history_cleared') {
            renderHistoryTable([]);
          } else if (data.type === 'desktop_status') {
            const label = daemonStatus.querySelector('.status-label');
            if (label) {
              label.textContent = data.connected ? 'Desktop Bridge Active' : 'Desktop Bridge Disconnected';
            }
          }
        } catch {}
      };

      state.ws.onerror = (err) => {
        console.warn('[WebSocket] Error:', err);
      };

      state.ws.onclose = () => {
        daemonStatus.querySelector('.status-dot').style.background = '#f59e0b';
        daemonStatus.querySelector('.status-label').textContent = 'Web Engine Ready';

        // Exponential backoff reconnection (max 30s)
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          setTimeout(initWebSocket, Math.min(state.reconnectDelay, 30000));
          state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 30000);
        }
      };
    } catch {
      daemonStatus.querySelector('.status-label').textContent = 'Web Engine Ready';
    }
  }

  // Speech Recognition Setup (Web Speech API)
  function initSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      showToast('Web Speech API not supported in this browser. Please use Chrome, Edge, or configure Groq key.');
      return;
    }

    const langSelect = document.getElementById('langSelect');
    state.recognition = new SpeechRec();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.lang = langSelect ? langSelect.value : 'en-IN';

    state.recognition.onstart = () => {
      state.interimText = '';
    };

    state.recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (final) {
        state.rawText += final;
      }
      state.interimText = interim;

      // Update Live Display
      const fullDisplay = (state.rawText + (interim ? ' ' + interim : '')).trim();
      renderRawTranscript(fullDisplay);
    };

    state.recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
    };

    state.recognition.onend = () => {
      if (state.isRecording) {
        try { state.recognition.start(); } catch {}
      }
    };
  }

  // Audio Context & Analyser
  async function startAudioCapture() {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 128;

      const source = state.audioContext.createMediaStreamSource(state.mediaStream);
      source.connect(state.analyser);
    } catch (err) {
      console.warn('Microphone stream access error:', err);
    }
  }

  function stopAudioCapture() {
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }
    if (state.audioContext) {
      state.audioContext.close();
      state.audioContext = null;
    }
  }

  // Canvas Waveform Animation Loop
  function setupCanvasAnimation() {
    const bufferLength = 64;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      requestAnimationFrame(draw);

      if (state.isRecording && state.analyser) {
        state.analyser.getByteFrequencyData(dataArray);
      } else {
        dataArray.fill(0);
      }

      // Draw Main Visualizer
      mainCtx.clearRect(0, 0, mainVisualizer.width, mainVisualizer.height);
      const barWidth = (mainVisualizer.width / bufferLength) * 1.8;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i];
        const barHeight = state.isRecording ? Math.max(4, (val / 255) * mainVisualizer.height * 0.85) : 4;

        const grad = mainCtx.createLinearGradient(0, mainVisualizer.height, 0, 0);
        grad.addColorStop(0, '#00f2fe');
        grad.addColorStop(1, '#7928ca');

        mainCtx.fillStyle = grad;
        mainCtx.beginPath();
        mainCtx.roundRect(x, (mainVisualizer.height - barHeight) / 2, barWidth - 2, barHeight, 3);
        mainCtx.fill();

        x += barWidth;
      }

      // Draw Mini Capsule Waveform
      capsuleCtx.clearRect(0, 0, capsuleWaveform.width, capsuleWaveform.height);
      const capBarWidth = capsuleWaveform.width / 16;
      let capX = 0;
      for (let i = 0; i < 16; i++) {
        const val = state.isRecording ? dataArray[i * 2] : 20;
        const capBarHeight = Math.max(3, (val / 255) * capsuleWaveform.height * 0.8);

        capsuleCtx.fillStyle = state.isRecording ? '#00f2fe' : '#6e7681';
        capsuleCtx.beginPath();
        capsuleCtx.roundRect(capX, (capsuleWaveform.height - capBarHeight) / 2, capBarWidth - 2, capBarHeight, 2);
        capsuleCtx.fill();
        capX += capBarWidth;
      }
    }

    draw();
  }

  // Record Toggle
  async function toggleRecording() {
    if (!state.isRecording) {
      await startRecording();
    } else {
      await stopRecording();
    }
  }

  async function startRecording() {
    state.isRecording = true;
    state.rawText = '';
    state.interimText = '';
    state.startTime = Date.now();

    playChime('start');
    recordBtn.classList.add('recording');
    recordBtnText.textContent = 'Finish Dictating';
    hudCapsule.classList.add('recording');
    capsuleLabel.textContent = 'Listening...';
    visualizerGlow.classList.add('active');

    rawTextDisplay.innerHTML = '<span class="placeholder-text">Listening... Speak now</span>';
    polishedTextDisplay.innerHTML = '<span class="placeholder-text">Polishing will stream on finish...</span>';
    polishLatencyBadge.textContent = 'Processing...';

    // Start timer
    state.timerInterval = setInterval(updateTimer, 500);

    // Start microphone & recognition
    await startAudioCapture();
    if (state.recognition) {
      const langSelect = document.getElementById('langSelect');
      if (langSelect) state.recognition.lang = langSelect.value;
      try { state.recognition.start(); } catch {}
    }

    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'dictation_started' }));
    }
  }

  async function stopRecording() {
    const elapsedSec = ((Date.now() - state.startTime) / 1000).toFixed(1);
    state.isRecording = false;

    playChime('stop');
    clearInterval(state.timerInterval);
    recordBtn.classList.remove('recording');
    recordBtnText.textContent = 'Start Dictating';
    hudCapsule.classList.remove('recording');
    capsuleLabel.textContent = 'Polishing speech...';
    visualizerGlow.classList.remove('active');

    if (state.recognition) {
      try { state.recognition.stop(); } catch {}
    }
    stopAudioCapture();

    // Small delay to allow Chrome to flush the final speech result
    await new Promise(resolve => setTimeout(resolve, 250));

    const finalText = (state.rawText + (state.interimText ? ' ' + state.interimText : '')).trim();

    if (!finalText) {
      rawTextDisplay.innerHTML = '<span class="placeholder-text">No speech was detected. Please try speaking closer to mic.</span>';
      polishedTextDisplay.innerHTML = '<span class="placeholder-text">Empty result.</span>';
      capsuleLabel.textContent = 'Click Mic to Speak';
      return;
    }

    // Call Polishing Pipeline
    await processAndPolish(finalText, elapsedSec);
    capsuleLabel.textContent = 'Ready (Press Space)';
  }

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    capsuleTimer.textContent = `${mins}:${secs}`;
  }

  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderRawTranscript(text) {
    if (!text) {
      rawTextDisplay.innerHTML = '<span class="placeholder-text">Speak naturally into your microphone...</span>';
      return;
    }

    // 🛡️ Sanitize user speech before applying visual styling
    const safeText = escapeHTML(text);
    const fillerRegex = /\b(um|uh|erm|er|ah|you know|basically|actually|so yeah)\b/gi;
    const highlighted = safeText.replace(fillerRegex, '<span class="filler-removed">$1</span>');
    rawTextDisplay.innerHTML = highlighted;

    const words = text.split(/\s+/).filter(Boolean).length;
    const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
    rawMeta.textContent = `${words} words · ${elapsed}s`;
  }

  // 🛡️ SECURITY (B1): REST calls must carry the user-entered API token.
  // The token lives in localStorage, never in shipped client JS.
  function authHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (state.settings.apiToken) h['x-talkity-token'] = state.settings.apiToken;
    return h;
  }

  // Polish Pipeline
  async function processAndPolish(rawText, durationSec) {
    const reqStart = Date.now();
    polishLatencyBadge.textContent = 'Polishing...';

    const headers = authHeaders();

    try {
      const res = await fetch('/api/polish', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          rawText,
          context: state.currentApp,
          tone: state.currentTone,
          dictionary: state.dictionary
        })
      });

      const data = await res.json();
      const latency = Date.now() - reqStart;
      state.polishedText = data.formattedText || rawText;

      polishedTextDisplay.textContent = state.polishedText;
      polishLatencyBadge.textContent = `${latency}ms (${data.provider || 'AI'})`;

      // Auto-copy to clipboard
      if (state.settings.autoCopy) {
        copyToClipboard(state.polishedText, false);
      }

      // Record to History
      saveHistoryRecord({
        asrText: rawText,
        formattedText: state.polishedText,
        tone: state.currentTone,
        duration: Number(durationSec),
        app: getAppName(state.currentApp),
        latencyMs: latency
      });

    } catch (err) {
      console.error('Polish error:', err);
      state.polishedText = rawText;
      polishedTextDisplay.textContent = rawText;
      polishLatencyBadge.textContent = 'Local Fallback';
    }
  }

  function getAppName(appId) {
    const map = {
      slack: 'Slack',
      code: 'VS Code',
      gmail: 'Gmail',
      notes: 'Notes'
    };
    return map[appId] || 'App';
  }

  // Copy to Clipboard
  function copyToClipboard(text, notify = true) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (notify) showToast('Copied to system clipboard! 📋');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (notify) showToast('Copied to clipboard!');
    });
  }

  // Inject Text into Mock Sandbox App
  function insertToSandbox(text) {
    if (!text) text = state.polishedText || 'Hello from Talkity!';

    if (state.currentApp === 'slack') {
      const el = document.getElementById('slackInput');
      el.value = (el.value ? el.value + ' ' : '') + text;
      el.focus();
    } else if (state.currentApp === 'code') {
      const el = document.getElementById('codeInput');
      el.value = (el.value ? el.value + '\n  ' : '') + text;
      el.focus();
    } else if (state.currentApp === 'gmail') {
      const el = document.getElementById('gmailBody');
      el.value = (el.value ? el.value + '\n' : '') + text;
      el.focus();
    } else if (state.currentApp === 'notes') {
      const el = document.getElementById('notesInput');
      el.value = (el.value ? el.value + '\n• ' : '• ') + text;
      el.focus();
    }

    showToast(`Injected text into ${getAppName(state.currentApp)} sandbox! ⚡`);
  }

  // Inject into Real OS Active Window
  async function injectToActiveOSApp(text) {
    if (!text) text = state.polishedText;
    if (!text) {
      showToast('No transcribed text to paste');
      return;
    }

    copyToClipboard(text, false);

    try {
      const res = await fetch('/api/inject', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      showToast('Dispatched Ctrl+V paste signal to active window! 🚀');
    } catch {
      showToast('Copied to clipboard! (Desktop daemon offline)');
    }
  }

  // Dictionary Management
  async function fetchDictionary() {
    try {
      const res = await fetch('/api/dictionary', { headers: authHeaders() });
      state.dictionary = await res.json();
      renderDictionaryTable();
    } catch {}
  }

  function renderDictionaryTable() {
    dictTableBody.innerHTML = '';
    state.dictionary.forEach((item, index) => {
      const row = document.createElement('tr');

      const tdPhrase = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = item.phrase || '';
      tdPhrase.appendChild(code);

      const tdRep = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = item.replacement || '';
      tdRep.appendChild(strong);

      const tdAction = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-del';
      delBtn.setAttribute('data-index', String(index));
      delBtn.title = 'Delete rule';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', async () => {
        await fetch(`/api/dictionary/${index}`, { method: 'DELETE', headers: authHeaders() });
        fetchDictionary();
      });
      tdAction.appendChild(delBtn);

      row.appendChild(tdPhrase);
      row.appendChild(tdRep);
      row.appendChild(tdAction);
      dictTableBody.appendChild(row);
    });
  }

  // History Management & Page Reset
  async function clearHistoryAndResetPage() {
    try {
      await fetch('/api/history', { method: 'DELETE', headers: authHeaders() });
    } catch (e) {
      console.warn('History clear error on load:', e);
    }
    renderHistoryTable([]);

    // Reset internal state
    state.rawText = '';
    state.interimText = '';
    state.polishedText = '';

    // Reset UI Displays
    if (rawTextDisplay) {
      rawTextDisplay.innerHTML = '<span class="placeholder-text">Speak naturally into your microphone. Your unedited acoustic stream will render here...</span>';
    }
    if (polishedTextDisplay) {
      polishedTextDisplay.innerHTML = '<span class="placeholder-text">Polished, punctuated text with filler words removed will appear here ready to insert...</span>';
    }
    if (rawMeta) {
      rawMeta.textContent = '0 words · 0.0s';
    }
    if (polishLatencyBadge) {
      polishLatencyBadge.textContent = 'Ready';
      polishLatencyBadge.className = 'badge badge-success';
    }

    // Reset Sandbox Inputs to clean empty state
    const sandboxFields = ['slackInput', 'codeInput', 'gmailBody', 'notesInput'];
    sandboxFields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // Reset Tone Pills to clean default
    tonePills.forEach(p => {
      if (p.getAttribute('data-tone') === 'clean') {
        p.classList.add('active');
      } else {
        p.classList.remove('active');
      }
    });
    state.currentTone = 'clean';

    // Reset HUD Capsule & Button
    if (capsuleLabel) capsuleLabel.textContent = 'Click Mic to Speak';
    if (capsuleTimer) capsuleTimer.textContent = '00:00';
    if (recordBtnText) recordBtnText.textContent = 'Start Dictating';
  }

  async function fetchHistory() {
    try {
      const res = await fetch('/api/history', { headers: authHeaders() });
      const items = await res.json();
      renderHistoryTable(items);
    } catch {}
  }

  async function saveHistoryRecord(record) {
    try {
      await fetch('/api/history', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(record)
      });
      fetchHistory();
    } catch {}
  }

  function renderHistoryTable(items) {
    historyTableBody.innerHTML = '';
    if (!items || items.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyTd = document.createElement('td');
      emptyTd.colSpan = 7;
      emptyTd.className = 'text-dim';
      emptyTd.style.textAlign = 'center';
      emptyTd.textContent = 'No past dictations found.';
      emptyRow.appendChild(emptyTd);
      historyTableBody.appendChild(emptyRow);
      return;
    }

    items.forEach(item => {
      const row = document.createElement('tr');
      const dateStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Time
      const tdTime = document.createElement('td');
      const smallTime = document.createElement('small');
      smallTime.className = 'text-dim';
      smallTime.textContent = dateStr;
      tdTime.appendChild(smallTime);

      // App
      const tdApp = document.createElement('td');
      const badgeApp = document.createElement('span');
      badgeApp.className = 'badge badge-subtle';
      badgeApp.textContent = item.app || 'Web';
      tdApp.appendChild(badgeApp);

      // Words
      const tdWords = document.createElement('td');
      tdWords.textContent = String(item.numWords || 0);

      // Duration
      const tdDuration = document.createElement('td');
      tdDuration.textContent = `${item.duration || 0}s`;

      // Tone
      const tdTone = document.createElement('td');
      const badgeTone = document.createElement('span');
      badgeTone.className = 'badge badge-engine';
      badgeTone.textContent = item.tone || 'clean';
      tdTone.appendChild(badgeTone);

      // Polished Text (Safe from XSS via textContent)
      const tdText = document.createElement('td');
      tdText.style.maxWidth = '320px';
      tdText.style.textOverflow = 'ellipsis';
      tdText.style.overflow = 'hidden';
      tdText.style.whiteSpace = 'nowrap';
      tdText.title = item.formattedText || '';
      tdText.textContent = item.formattedText || '';

      // Copy Action
      const tdAction = document.createElement('td');
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-xs btn-outline';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        copyToClipboard(item.formattedText || '');
      });
      tdAction.appendChild(copyBtn);

      row.appendChild(tdTime);
      row.appendChild(tdApp);
      row.appendChild(tdWords);
      row.appendChild(tdDuration);
      row.appendChild(tdTone);
      row.appendChild(tdText);
      row.appendChild(tdAction);
      historyTableBody.appendChild(row);
    });
  }

  // Toast Notification (🛡️ XSS Safe)
  function showToast(msg) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    const icon = document.createElement('span');
    icon.textContent = '✨ ';
    const textNode = document.createElement('span');
    textNode.textContent = msg;
    toast.appendChild(icon);
    toast.appendChild(textNode);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  // Event Listeners
  function attachEventListeners() {
    recordBtn.addEventListener('click', toggleRecording);
    hudCapsule.addEventListener('click', toggleRecording);

    // Tone Pills
    tonePills.forEach(pill => {
      pill.addEventListener('click', () => {
        tonePills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.currentTone = pill.getAttribute('data-tone');
        // Repolish current text if available
        if (state.rawText) {
          processAndPolish(state.rawText, 0);
        }
      });
    });

    // App Sandbox Switcher
    appTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        appTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentApp = tab.getAttribute('data-app');

        document.querySelectorAll('.app-viewport').forEach(vp => vp.classList.remove('active'));
        const vpId = 'viewport' + state.currentApp.charAt(0).toUpperCase() + state.currentApp.slice(1);
        const targetVp = document.getElementById(vpId);
        if (targetVp) targetVp.classList.add('active');
      });
    });

    insertToSandboxBtn.addEventListener('click', () => insertToSandbox());
    copyBtn.addEventListener('click', () => copyToClipboard(state.polishedText));
    injectActiveAppBtn.addEventListener('click', () => injectToActiveOSApp(state.polishedText));

    // Custom Dictionary Form
    dictForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phrase = document.getElementById('dictPhrase').value.trim();
      const replacement = document.getElementById('dictReplacement').value.trim();

      if (phrase && replacement) {
        await fetch('/api/dictionary', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ phrase, replacement })
        });
        dictForm.reset();
        fetchDictionary();
        showToast(`Rule added: "${phrase}" → "${replacement}"`);
      }
    });

    // Language selector change listener
    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
      langSelect.addEventListener('change', () => {
        if (state.recognition) {
          state.recognition.lang = langSelect.value;
        }
        showToast(`Language set to ${langSelect.options[langSelect.selectedIndex].text}`);
      });
    }

    // Clear History & Reset Page
    clearHistoryBtn.addEventListener('click', async () => {
      await clearHistoryAndResetPage();
      showToast('History cleared & fresh page started! ✨');
    });

    // Settings Modal
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('open'));
    closeSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('open'));
    saveSettingsBtn.addEventListener('click', saveSettings);

    // Keyboard Shortcuts: Spacebar to toggle when not focused on an input
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        toggleRecording();
      }
    });
  }

  // Start app
  document.addEventListener('DOMContentLoaded', init);
})();
