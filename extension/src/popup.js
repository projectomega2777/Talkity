// Talkity Chrome Extension - Popup Logic

document.addEventListener('DOMContentLoaded', () => {
  const recordBtn = document.getElementById('recordBtn');
  const recordBtnText = document.getElementById('recordBtnText');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const transcriptBox = document.getElementById('transcriptBox');
  const serverUrlInput = document.getElementById('serverUrlInput');

  let isRecording = false;
  let recognition = null;

  // Load saved server URL
  chrome.storage.local.get(['serverUrl'], (res) => {
    if (res.serverUrl) {
      serverUrlInput.value = res.serverUrl;
    }
  });

  serverUrlInput.addEventListener('change', () => {
    const url = serverUrlInput.value.trim();
    chrome.storage.local.set({ serverUrl: url }, () => {
      // Reconnect background
      chrome.runtime.reload();
    });
  });

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
        // Send to background to relay to server and inject
        chrome.runtime.sendMessage({
          action: 'send_transcription',
          text: final,
          tone: 'clean'
        });

        // Also inject directly into active tab content script as a reliable fallback
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0] && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'talkity_inject',
              text: final
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
        try { recognition.start(); } catch {}
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
    try { recognition.start(); } catch {}
  }

  function stopRecording() {
    isRecording = false;
    recordBtn.classList.remove('recording');
    recordBtnText.textContent = 'Start Recording';
    try { recognition.stop(); } catch {}
  }

  recordBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
});
