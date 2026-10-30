// Talkity Chrome Extension - Popup Logic
// Minimal UI: status + Start Recording button + transcript.

document.addEventListener('DOMContentLoaded', () => {
  const recordBtn = document.getElementById('recordBtn');
  const recordBtnText = document.getElementById('recordBtnText');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const transcriptBox = document.getElementById('transcriptBox');
  const apiTokenInput = document.getElementById('apiTokenInput');
  const saveTokenBtn = document.getElementById('saveTokenBtn');

  let isRecording = false;
  let recognition = null;

  // Production default is locked to Render backend; no user config.
  const PRODUCTION_WS_URL = 'wss://talkity-qifh.onrender.com/';

  // Check connection status periodically
  function updateConnectionStatus() {
    chrome.runtime.sendMessage({ action: 'get_connection_status' }, (res) => {
      if (res && res.connected) {
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected to Bridge';
      } else {
        statusDot.classList.remove('connected');
        statusText.textContent = 'Disconnected (Using local speech)';
      }
    });
  }

  setInterval(updateConnectionStatus, 2000);
  updateConnectionStatus();

  // 🛡️ SECURITY (B1): the deployment token lives in chrome.storage.local and
  // never in shipped client JS. Saving it reconnects the bridge.
  chrome.storage.local.get(['talkityApiToken'], (cfg) => {
    if (cfg && cfg.talkityApiToken) apiTokenInput.value = cfg.talkityApiToken;
  });
  saveTokenBtn.addEventListener('click', () => {
    const token = apiTokenInput.value.trim();
    chrome.storage.local.set({ talkityApiToken: token }, () => {
      if (typeof token !== 'string') return; // storage callback invariant
      saveTokenBtn.textContent = 'Saved ✓';
      setTimeout(() => { saveTokenBtn.textContent = 'Save'; }, 1500);
      // Existing handler triggers a bridge reconnect with the new token.
      chrome.runtime.sendMessage({ action: 'reload_connection' }, () => {});
    });
  });

  // Initialize Speech Recognition
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (final) {
        transcriptBox.textContent = final;
        // Relay transcription to background + content script
        chrome.runtime.sendMessage({
          action: 'send_transcription',
          text: final,
          tone: 'clean'
        }, (bgRes) => {
          if (!bgRes || !bgRes.success) {
            console.warn('[Talkity Popup] Background relay failed:', bgRes?.error);
          }
        });

        // Also inject directly into active tab content script as a reliable fallback
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0] && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'talkity_inject',
              text: final
            }, (csRes) => {
              if (chrome.runtime.lastError) {
                console.warn('[Talkity Popup] Content script injection failed:', chrome.runtime.lastError.message);
              }
            });
          }
        });
      } else if (interim) {
        transcriptBox.textContent = interim;
      }
    };

    recognition.onerror = () => {
      stopRecording();
    };

    recognition.onend = () => {
      if (isRecording) {
        try { recognition.start(); } catch (_) {}
      }
    };
  }

  function startRecording() {
    if (!recognition) {
      alert('Web Speech API is not supported in this browser popup.');
      return;
    }
    isRecording = true;
    recordBtn.classList.add('recording');
    recordBtnText.textContent = 'Stop Recording';
    try { recognition.start(); } catch (_) {}
  }

  function stopRecording() {
    isRecording = false;
    recordBtn.classList.remove('recording');
    recordBtnText.textContent = 'Start Recording';
    try { recognition.stop(); } catch (_) {}
  }

  recordBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
});