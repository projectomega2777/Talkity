/* Talkity landing page — intro sequence, particle field, scroll reveals */
(function () {
  'use strict';

  var INTRO_KEY = 'talkity:intro-seen';
  /* 2.3s on screen + 0.7s fade = ~3s total intro */
  var INTRO_HOLD_MS = 2300;
  var FADE_MS = 700;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var root = document.documentElement;
  var intro = document.getElementById('intro');
  var skipBtn = document.getElementById('skipIntro');
  var playBtn = document.getElementById('playIntro');
  var canvas = document.getElementById('introCanvas');

  var timer = null;
  var stopParticles = null;
  var dismissing = false;
  var inerted = [];

  function readSeen() {
    try {
      return sessionStorage.getItem(INTRO_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function markSeen() {
    try {
      sessionStorage.setItem(INTRO_KEY, '1');
    } catch (err) {
      /* storage unavailable — the intro simply shows again next visit */
    }
  }

  function setPageInert(on) {
    if (on) {
      inerted = [];
      Array.prototype.forEach.call(document.body.children, function (el) {
        if (el === intro || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
        if (el.hasAttribute('inert')) return;
        el.setAttribute('inert', '');
        inerted.push(el);
      });
      return;
    }
    inerted.forEach(function (el) {
      el.removeAttribute('inert');
    });
    inerted = [];
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissIntro();
    }
  }

  function startIntro() {
    if (!intro) return;
    intro.hidden = false;
    root.classList.remove('intro-pending');
    document.body.classList.add('intro-active');
    setPageInert(true);
    /* Start the dismiss timer first: if the canvas fails on an old or
       low-power device, the intro still clears itself on schedule. */
    timer = window.setTimeout(dismissIntro, INTRO_HOLD_MS);
    try {
      stopParticles = startParticles(canvas);
    } catch (err) {
      stopParticles = null;
    }
    document.addEventListener('keydown', onKeydown, true);
  }

  function dismissIntro() {
    if (dismissing || !intro || intro.hidden) return;
    dismissing = true;
    window.clearTimeout(timer);
    markSeen();
    document.removeEventListener('keydown', onKeydown, true);
    intro.classList.add('is-out');
    intro.setAttribute('aria-hidden', 'true');

    window.setTimeout(function () {
      intro.hidden = true;
      intro.classList.remove('is-out');
      intro.removeAttribute('aria-hidden');
      document.body.classList.remove('intro-active');
      setPageInert(false);
      if (stopParticles) {
        stopParticles();
        stopParticles = null;
      }
      dismissing = false;

      var active = document.activeElement;
      if (!active || active === document.body || intro.contains(active)) {
        var main = document.getElementById('main');
        if (main) {
          main.setAttribute('tabindex', '-1');
          main.focus({ preventScroll: true });
          main.addEventListener('blur', function () {
            main.removeAttribute('tabindex');
          }, { once: true });
        }
      }
    }, FADE_MS);
  }

  /* ------------------------------------------------------- particle ring */

  function startParticles(el) {
    if (!el || reduceMotion.matches) return null;
    var ctx = el.getContext('2d');
    if (!ctx) return null;

    /* Slower devices / data-saver: fewer lines, lower pixel ratio. */
    var lowPower = !!((navigator.connection && navigator.connection.saveData) ||
      (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2));
    var dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1 : 2);

    var width = 0;
    var height = 0;
    var cx = 0;
    var cy = 0;
    var radius = 0;
    var raf = 0;
    var running = true;
    var paused = false;
    var started = 0;
    var seeded = false;
    var lines = [];

    var EMERGE_MS = 900;
    var ALPHA_STEPS = 5;
    var TONES = [
      { color: '255,255,255', width: 0.9 },
      { color: '255,255,255', width: 1.5 },
      { color: '205,205,205', width: 0.6 }
    ];
    var BUCKETS = TONES.length * ALPHA_STEPS;
    var buffers = [];
    var counts = new Int32Array(BUCKETS);

    function seed() {
      var area = width * height;
      var count = lowPower ? 280 : (area > 1100000 ? 1000 : 700);
      lines = [];
      for (var i = 0; i < count; i++) {
        var tone = Math.random() < 0.16 ? 1 : (Math.random() < 0.55 ? 0 : 2);
        lines.push({
          angle: Math.random() * Math.PI * 2,
          inner: 0.92 + Math.random() * 0.08,
          len: 0.012 + Math.pow(Math.random(), 2.6) * 0.3,
          alpha: 0.07 + Math.random() * 0.8,
          delay: Math.random() * 460,
          speed: 0.5 + Math.random() * 1.7,
          phase: Math.random() * Math.PI * 2,
          drift: (Math.random() - 0.5) * 0.02,
          tone: tone
        });
      }
      buffers = [];
      for (var b = 0; b < BUCKETS; b++) buffers.push(new Float32Array(count * 4));
      seeded = true;
    }

    function resize() {
      var rect = el.getBoundingClientRect();
      width = Math.max(rect.width, 1);
      height = Math.max(rect.height, 1);
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = width / 2;
      cy = height / 2;
      radius = Math.min(Math.min(width, height) * 0.36, width * 0.46);
      if (!seeded) seed();
    }

    function frame(now) {
      if (!running) return;
      if (!started) started = now || performance.now();
      var t = (now || performance.now()) - started;

      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = 'round';

      var rot = t * 0.000018;
      var emerge = Math.min(1, t / EMERGE_MS);
      counts.fill(0);

      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        var p = (t - l.delay) / EMERGE_MS;
        if (p <= 0) continue;
        if (p > 1) p = 1;
        p = 1 - Math.pow(1 - p, 3);

        var ang = l.angle + rot + l.drift * (t / 1000) +
          Math.sin(t * 0.0004 + l.phase) * 0.006;
        var breathe = Math.sin(t * 0.0011 + l.phase) * radius * 0.012;
        var r0 = (radius * l.inner + breathe) * p;
        var len = radius * l.len * p * (0.8 + 0.2 * Math.sin(t * 0.0015 + l.phase * 2));
        var cos = Math.cos(ang);
        var sin = Math.sin(ang);

        var flick = 0.5 + 0.5 * Math.sin(t * 0.0012 * l.speed + l.phase);
        if (Math.sin(t * 0.0008 + l.phase * 5.3) > 0.985) flick = 1;
        var alpha = l.alpha * (0.35 + 0.65 * flick) * (0.55 + 0.45 * emerge);
        if (alpha <= 0.012) continue;

        var ai = alpha * ALPHA_STEPS;
        if (ai >= ALPHA_STEPS) ai = ALPHA_STEPS - 1;
        var bucket = l.tone * ALPHA_STEPS + (ai | 0);
        var buf = buffers[bucket];
        var n = counts[bucket] * 4;
        buf[n] = cx + cos * r0;
        buf[n + 1] = cy + sin * r0;
        buf[n + 2] = cx + cos * (r0 + len);
        buf[n + 3] = cy + sin * (r0 + len);
        counts[bucket]++;
      }

      for (var b = 0; b < BUCKETS; b++) {
        var c = counts[b];
        if (!c) continue;
        var tone = TONES[(b / ALPHA_STEPS) | 0];
        var a = (((b % ALPHA_STEPS) + 0.6) / ALPHA_STEPS) * 0.9;
        var data = buffers[b];
        ctx.beginPath();
        for (var k = 0; k < c; k++) {
          var o = k * 4;
          ctx.moveTo(data[o], data[o + 1]);
          ctx.lineTo(data[o + 2], data[o + 3]);
        }
        ctx.strokeStyle = 'rgba(' + tone.color + ',' + a.toFixed(3) + ')';
        ctx.lineWidth = tone.width;
        ctx.stroke();
      }

      raf = window.requestAnimationFrame(frame);
    }

    function onVisibility() {
      if (document.hidden) {
        if (!running || paused) return;
        paused = true;
        window.cancelAnimationFrame(raf);
      } else if (paused && running) {
        paused = false;
        raf = window.requestAnimationFrame(frame);
      }
    }

    resize();
    raf = window.requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);

    return function stop() {
      running = false;
      paused = false;
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      ctx.clearRect(0, 0, width, height);
    };
  }

  /* ------------------------------------------------------------ recorder */

  /* One engine, two mounts: the compact hero HUD and the full demo.
     It records with getUserMedia, converts the clip to 16 kHz mono WAV and
     posts it to the existing /api/transcribe endpoint. No keys, no
     third-party SDKs, and no audio ever leaves the Talkity backend. */

  var activeRecorder = null;

  function createRecorder(app, options) {
    if (!app) return null;

    var opts = options || {};
    var full = !!opts.full;

    function el(name) {
      return app.querySelector('[data-el="' + name + '"]');
    }

    var startBtn = el('start');
    var startLabel = el('startLabel');
    var stopBtn = el('stop');
    var copyBtn = el('copy');
    var copyLabel = el('copyLabel') || copyBtn;
    var clearBtn = el('clear');
    var statusText = el('status');
    var timerEl = el('timer');
    var transcriptEl = el('transcript');
    var placeholderEl = el('placeholder');
    var providerEl = el('provider');
    var canvas = el('wave');
    var langSelect = el('lang');

    if (!startBtn || !transcriptEl) return null;

    var MAX_MS = 60000;
    var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
    var SAMPLE_RATE = 16000;
    var IDLE_HINT = full
      ? 'Press “Start speaking”, allow the microphone, and talk normally. Your words will appear here.'
      : 'Press start and speak — your words appear here.';
    var copyText = copyLabel ? copyLabel.textContent : '';

    var phase = 'idle';
    var stream = null;
    var recorder = null;
    var chunks = [];
    var mimeType = '';
    var audioCtx = null;
    var analyser = null;
    var freq = null;
    var raf = 0;
    var ticker = 0;
    var startedAt = 0;
    var elapsed = 0;
    var text = '';
    var runId = 0;
    var autoStop = 0;
    var reduced = reduceMotion.matches;
    var settled = false;
    var stopReason = '';

    var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    var width = 0;
    var height = 0;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    /* ------------------------------------------------------------ waveform */

    function sizeCanvas() {
      if (!ctx) return;
      var rect = canvas.getBoundingClientRect();
      width = Math.max(rect.width, 1);
      height = Math.max(rect.height, 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (phase !== 'recording') drawIdle(settled);
    }

    function drawIdle(accent) {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      var bars = Math.max(24, Math.floor(width / 13));
      var gap = width / bars;
      var mid = height / 2;
      ctx.fillStyle = accent ? 'rgba(245, 166, 35, 0.34)' : 'rgba(245, 245, 245, 0.12)';
      for (var i = 0; i < bars; i++) {
        var h = accent ? 2 + (Math.sin(i * 1.55) * 0.5 + 0.5) * height * 0.22 : 2;
        ctx.fillRect(i * gap + gap * 0.3, mid - h / 2, Math.max(2, gap * 0.4), h);
      }
    }

    function drawLive() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      var bars = Math.max(24, Math.floor(width / 11));
      var gap = width / bars;
      var mid = height / 2;
      var half = bars / 2;
      if (analyser) analyser.getByteFrequencyData(freq);
      /* Mirror the spectrum around the centre: speech energy lives in the low
         bins, so a straight left-to-right sweep left the right half flat.
         Both halves now read low-to-high frequencies outward. */
      var usable = freq ? Math.max(1, Math.floor(freq.length * 0.72)) : 0;
      for (var i = 0; i < bars; i++) {
        var distance = Math.abs(i - half + 0.5) / half;
        var bin = Math.floor(Math.pow(distance, 0.85) * usable);
        var value = freq ? freq[Math.min(freq.length - 1, bin)] / 255 : 0;
        value = Math.pow(value, 0.68);
        var barHeight = Math.max(3, value * height * 0.88);
        var alpha = 0.28 + value * 0.72;
        ctx.fillStyle = 'rgba(245, 166, 35, ' + alpha.toFixed(3) + ')';
        ctx.fillRect(i * gap + gap * 0.26, mid - barHeight / 2, Math.max(2, gap * 0.48), barHeight);
      }
    }

    function frame() {
      if (phase !== 'recording') return;
      drawLive();
      raf = window.requestAnimationFrame(frame);
    }

    function startWave() {
      if (!ctx) return;
      if (reduced) {
        drawLive();
        return;
      }
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(frame);
    }

    function stopWave() {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      drawIdle(settled);
    }

    /* ------------------------------------------------------------- helpers */

    function setStatus(message) {
      if (statusText) statusText.textContent = message;
    }

    function setProvider(name) {
      if (!providerEl) return;
      if (name) {
        providerEl.textContent = name;
        providerEl.hidden = false;
      } else {
        providerEl.hidden = true;
        providerEl.textContent = '';
      }
    }

    function providerLabel(value) {
      if (!value) return '';
      if (value.indexOf('groq') === 0) return 'Whisper large-v3';
      if (value.indexOf('openai') === 0) return 'Whisper';
      return String(value);
    }

    function showText(value) {
      text = value || '';
      transcriptEl.textContent = '';
      if (text) {
        var p = document.createElement('p');
        p.textContent = text;
        transcriptEl.appendChild(p);
        transcriptEl.scrollTop = 0;
      } else if (placeholderEl) {
        transcriptEl.appendChild(placeholderEl);
      }
    }

    function setPhase(next) {
      phase = next;
      app.setAttribute('data-state', next);
      var busy = next === 'requesting' || next === 'working';
      startBtn.disabled = opts.toggle ? busy : (busy || next === 'recording');
      if (stopBtn) stopBtn.disabled = next !== 'recording';
      if (copyBtn) copyBtn.disabled = busy || !text;
      if (clearBtn) clearBtn.disabled = busy || (next === 'idle' && !text);
      if (langSelect) langSelect.disabled = busy || next === 'recording';
      if (next === 'recording') startLabel.textContent = opts.toggle ? 'Stop recording' : 'Recording…';
      else if (next === 'working') startLabel.textContent = 'Transcribing…';
      else if (next === 'error') startLabel.textContent = 'Try again';
      else startLabel.textContent = text ? 'Speak again' : 'Start speaking';
    }

    function formatTime(ms) {
      var total = Math.floor(ms / 1000);
      var mins = Math.floor(total / 60);
      var secs = total % 60;
      return mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    function startTimer() {
      startedAt = Date.now();
      elapsed = 0;
      if (timerEl) timerEl.textContent = '0:00';
      ticker = window.setInterval(function () {
        elapsed = Date.now() - startedAt;
        if (timerEl) timerEl.textContent = formatTime(elapsed);
      }, 200);
    }

    function stopTimer() {
      if (ticker) window.clearInterval(ticker);
      ticker = 0;
    }

    function stopTracks(mediaStream) {
      if (!mediaStream || typeof mediaStream.getTracks !== 'function') return;
      mediaStream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (err) {}
      });
    }

    function cleanupAudio() {
      if (activeRecorder === api) activeRecorder = null;
      if (autoStop) window.clearTimeout(autoStop);
      autoStop = 0;
      stopTimer();
      stopWave();
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder = null;
      }
      if (stream) {
        stopTracks(stream);
        stream = null;
      }
      if (audioCtx) {
        try { audioCtx.close(); } catch (err) {}
        audioCtx = null;
      }
      analyser = null;
      freq = null;
    }

    function fail(message, placeholder) {
      settled = false;
      cleanupAudio();
      setPhase('error');
      setStatus(message);
      if (!text) {
        if (placeholderEl) placeholderEl.textContent = placeholder || message || 'Something went wrong. Press Try again to retry.';
        showText('');
      }
    }

    function checkSupport() {
      if (!window.isSecureContext) {
        return 'Microphone access needs HTTPS or localhost. Open this page over HTTPS and try again.';
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return 'This browser cannot capture audio. Try Chrome, Edge, Firefox or Safari.';
      }
      if (typeof window.MediaRecorder === 'undefined') {
        return 'This browser cannot record audio. Try Chrome, Edge, Firefox or Safari.';
      }
      if (!(window.AudioContext || window.webkitAudioContext)) {
        return 'This browser cannot process audio. Try Chrome, Edge, Firefox or Safari.';
      }
      return '';
    }

    function micError(err) {
      var name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        fail('Microphone permission was denied. Allow it in your browser’s site settings, then try again.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        fail('No microphone was found. Connect one and try again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        fail('The microphone is busy in another app. Close it and try again.');
      } else if (name === 'OverconstrainedError') {
        fail('That microphone cannot be used with these settings. Try another device.');
      } else {
        fail('Could not start the microphone. Check your browser permissions and try again.');
      }
    }

    /* ------------------------------------------------------------- capture */

    function pickMime() {
      if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') return '';
      var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (var i = 0; i < list.length; i++) {
        if (window.MediaRecorder.isTypeSupported(list[i])) return list[i];
      }
      return '';
    }

    function openAnalyser(mediaStream) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        audioCtx = new Ctx();
        if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.75;
        freq = new Uint8Array(analyser.frequencyBinCount);
        var source = audioCtx.createMediaStreamSource(mediaStream);
        source.connect(analyser);
      } catch (err) {
        analyser = null;
        freq = null;
      }
    }

    function beginRecording(id) {
      try {
        mimeType = pickMime();
        recorder = mimeType ? new window.MediaRecorder(stream, { mimeType: mimeType }) : new window.MediaRecorder(stream);
      } catch (err) {
        cleanupAudio();
        fail('This browser cannot record audio. Try Chrome, Edge, Firefox or Safari.');
        return;
      }

      chunks = [];
      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onerror = function () {
        if (id !== runId) return;
        fail('Recording failed. Check your microphone and try again.');
      };
      recorder.onstop = function () {
        if (id !== runId) return;
        finish(id);
      };

      openAnalyser(stream);
      /* If the device disappears mid-recording, transcribe what we already
         captured instead of leaving a dead recorder running to the 60s cap.
         MediaRecorder may have stopped itself already; in that case its own
         onstop handler finishes the upload. */
      stream.getTracks().forEach(function (track) {
        track.addEventListener('ended', function () {
          if (id !== runId || phase !== 'recording') return;
          setStatus('Microphone disconnected — transcribing what was captured…');
          if (recorder && recorder.state === 'recording') stop('ended');
        });
      });
      showText('');
      if (placeholderEl) placeholderEl.textContent = 'Listening…';
      setPhase('recording');
      setStatus('Listening — speak naturally');
      startTimer();
      startWave();

      try {
        recorder.start(250);
      } catch (err) {
        fail('Recording could not start. Try again.');
        return;
      }

      autoStop = window.setTimeout(function () {
        if (phase === 'recording') {
          setStatus('Reached the 60 second limit — transcribing…');
          stop('limit');
        }
      }, MAX_MS);
    }

    function start() {
      if (phase === 'requesting' || phase === 'recording' || phase === 'working') return;

      var problem = checkSupport();
      if (problem) {
        fail(problem, problem);
        return;
      }

      /* Only one recorder may hold the microphone at a time. */
      if (activeRecorder && activeRecorder !== api) activeRecorder.cancel();

      var id = ++runId;
      settled = false;
      stopReason = '';
      setProvider('');
      showText('');
      if (placeholderEl) placeholderEl.textContent = 'Waiting for the microphone…';
      if (timerEl) timerEl.textContent = '0:00';
      setPhase('requesting');
      setStatus('Waiting for microphone permission…');
      activeRecorder = api;

      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }).then(function (mediaStream) {
        if (id !== runId) {
          stopTracks(mediaStream);
          return;
        }
        stream = mediaStream;
        beginRecording(id);
      }).catch(function (err) {
        if (id !== runId) return;
        micError(err);
      });
    }

    /* The reason a recording stopped is kept through the upload, so the
       "60 second limit" / "tab hidden" explanation does not get replaced by
       a generic "Uploading…" line the moment encoding starts. */
    function workingStatus(reason) {
      if (reason === 'limit') return 'Reached the 60 second limit — transcribing…';
      if (reason === 'hidden') return 'Recording stopped because the tab was hidden — transcribing…';
      if (reason === 'ended') return 'Microphone disconnected — transcribing what was captured…';
      return 'Uploading and transcribing…';
    }

    function stop(reason) {
      if (phase !== 'recording') return;
      stopReason = reason || 'user';
      elapsed = Date.now() - startedAt;
      stopTimer();
      stopWave();
      setPhase('working');
      setStatus(workingStatus(stopReason));
      if (placeholderEl) placeholderEl.textContent = 'Transcribing your recording…';
      transcriptEl.setAttribute('aria-busy', 'true');
      try {
        recorder.stop();
      } catch (err) {
        fail('Recording could not be stopped. Try again.');
      }
    }

    /* Stop without transcribing — used when the other recorder takes over. */
    function cancel() {
      if (phase !== 'recording' && phase !== 'requesting') return;
      runId++;
      cleanupAudio();
      setPhase(text ? 'done' : 'idle');
      setStatus('Ready when you are');
      if (timerEl) timerEl.textContent = '0:00';
      if (!text && placeholderEl) placeholderEl.textContent = IDLE_HINT;
      drawIdle(settled);
    }

    /* ------------------------------------------------------- encode + send */

    function writeAscii(view, offset, value) {
      for (var i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    }

    function encodePcm(audioBuffer) {
      var src = audioBuffer.getChannelData(0);
      var ratio = audioBuffer.sampleRate / SAMPLE_RATE;
      var length = Math.max(1, Math.floor(src.length / ratio));
      var out = new Float32Array(length);
      var i;
      var j;
      for (i = 0; i < length; i++) {
        var start = Math.floor(i * ratio);
        var end = Math.min(src.length, Math.floor((i + 1) * ratio));
        if (end <= start) end = Math.min(src.length, start + 1);
        var sum = 0;
        var count = 0;
        for (j = start; j < end; j++) {
          sum += src[j];
          count++;
        }
        out[i] = count ? sum / count : 0;
      }

      var buffer = new ArrayBuffer(44 + length * 2);
      var view = new DataView(buffer);
      writeAscii(view, 0, 'RIFF');
      view.setUint32(4, 36 + length * 2, true);
      writeAscii(view, 8, 'WAVE');
      writeAscii(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, SAMPLE_RATE, true);
      view.setUint32(28, SAMPLE_RATE * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(view, 36, 'data');
      view.setUint32(40, length * 2, true);

      var offset = 44;
      for (i = 0; i < length; i++) {
        var sample = out[i];
        if (sample < -1) sample = -1;
        else if (sample > 1) sample = 1;
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }

      return new Blob([buffer], { type: 'audio/wav' });
    }

    function toWav(blob) {
      return new Promise(function (resolve, reject) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!blob.arrayBuffer) {
          reject(new Error('Blob.arrayBuffer is unavailable'));
          return;
        }
        blob.arrayBuffer().then(function (buffer) {
          var decodeCtx;
          try {
            decodeCtx = new Ctx();
          } catch (err) {
            reject(err);
            return;
          }
          var close = function () {
            try { decodeCtx.close(); } catch (err) {}
          };
          decodeCtx.decodeAudioData(buffer.slice(0)).then(function (audioBuffer) {
            close();
            try {
              resolve(encodePcm(audioBuffer));
            } catch (err) {
              reject(err);
            }
          }, function (err) {
            close();
            reject(err);
          });
        }, reject);
      });
    }

    function finish(id) {
      var seconds = elapsed / 1000;
      cleanupAudio();
      transcriptEl.removeAttribute('aria-busy');

      if (seconds < 0.4) {
        fail('That recording was too short — speak for at least a second.');
        return;
      }
      if (!chunks.length) {
        fail('No audio was captured. Check your microphone and try again.');
        return;
      }

      var blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      chunks = [];
      if (!blob.size) {
        fail('No audio was captured. Check your microphone and try again.');
        return;
      }

      setStatus(workingStatus(stopReason));
      toWav(blob).then(function (wav) {
        if (id !== runId) return;
        return upload(wav, id);
      }).catch(function () {
        if (id !== runId) return;
        fail('The recording could not be processed. Try again.');
      });
    }

    function upload(wav, id) {
      if (wav.size > MAX_UPLOAD_BYTES) {
        fail('That recording is too large to send. Try a shorter clip.');
        return Promise.resolve();
      }

      var headers = { 'Content-Type': 'audio/wav' };
      var lang = langSelect ? langSelect.value : '';
      if (lang) headers['x-language'] = lang;

      var controller = null;
      try { controller = new AbortController(); } catch (err) {}
      var timeout = window.setTimeout(function () {
        if (controller) {
          try { controller.abort(); } catch (err) {}
        }
      }, 45000);

      var demoUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? '/api/demo/transcribe'
        : 'https://talkity-qifh.onrender.com/api/demo/transcribe';

      return fetch(demoUrl, {
        method: 'POST',
        headers: headers,
        body: wav,
        signal: controller ? controller.signal : undefined
      }).then(function (response) {
        window.clearTimeout(timeout);
        return response.json().catch(function () { return null; }).then(function (data) {
          return { response: response, data: data };
        });
      }).then(function (result) {
        if (id !== runId) return;
        handleResponse(result.response, result.data);
      }).catch(function (err) {
        window.clearTimeout(timeout);
        if (id !== runId) return;
        if (err && err.name === 'AbortError') {
          fail('The transcription service took too long to answer. Try a shorter recording.');
        } else {
          fail('Could not reach the transcription service. Check your connection and try again.');
        }
      });
    }

    function handleResponse(response, data) {
      if (response.ok) {
        var value = data ? (data.formattedText || data.text) : '';
        value = value ? String(value).trim() : '';
        if (!value) {
          fail('No speech was detected in that clip. Move closer to the microphone and try again.');
          return;
        }
        settled = true;
        showText(value);
        setProvider(providerLabel(data.provider));
        setPhase('done');
        drawIdle(true);
        var seconds = Math.round(elapsed / 100) / 10;
        setStatus('Transcribed ' + seconds + 's — copy it, or speak again');
        return;
      }

      var message = data && data.error ? String(data.error) : '';
      if (response.status === 429) {
        var wait = (data && data.retryAfterSeconds) || parseInt(response.headers.get('Retry-After'), 10) || 30;
        fail('Rate limit reached — try again in ' + wait + ' seconds.');
      } else if (response.status === 413) {
        fail('That recording was too large. Keep clips under about a minute.');
      } else if (response.status === 400 && /api key/i.test(message)) {
        fail('The transcription service is not configured right now. The desktop app can also use the offline Windows speech engine.');
      } else if (response.status === 400) {
        fail('The recording was too short or could not be read. Speak for a moment longer and try again.');
      } else if (response.status >= 500) {
        fail('The transcription service had a problem. Try again in a moment.');
      } else {
        fail(message || 'Transcription failed. Try again.');
      }
    }

    /* -------------------------------------------------------------- actions */

    function copyTranscript() {
      if (!text) return;
      var done = function () {
        setStatus('Transcript copied to the clipboard');
        if (copyLabel) copyLabel.textContent = 'Copied';
        window.setTimeout(function () {
          if (copyLabel) copyLabel.textContent = copyText;
        }, 1800);
      };
      var fallback = function () {
        try {
          var area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '-1000px';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(area);
          if (ok) done();
          else setStatus('Copy failed — select the transcript and copy it manually');
        } catch (err) {
          setStatus('Copy failed — select the transcript and copy it manually');
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    }

    function clearAll() {
      if (phase === 'requesting' || phase === 'recording' || phase === 'working') return;
      runId++;
      settled = false;
      cleanupAudio();
      setProvider('');
      showText('');
      if (placeholderEl) placeholderEl.textContent = IDLE_HINT;
      if (timerEl) timerEl.textContent = '0:00';
      setPhase('idle');
      setStatus('Ready when you are');
      drawIdle(false);
    }

    function onVisibility() {
      if (!document.hidden) return;
      if (phase === 'recording') {
        stop('hidden');
      } else if (phase === 'requesting') {
        runId++;
        cleanupAudio();
        setPhase('idle');
        setStatus('Ready when you are');
        if (placeholderEl) placeholderEl.textContent = IDLE_HINT;
      }
    }

    function onPageHide() {
      runId++;
      cleanupAudio();
    }

    var api = { cancel: cancel };

    if (opts.toggle) {
      startBtn.addEventListener('click', function () {
        if (phase === 'recording') stop('user');
        else start();
      });
    } else {
      startBtn.addEventListener('click', start);
      if (stopBtn) stopBtn.addEventListener('click', function () { stop('user'); });
    }
    if (copyBtn) copyBtn.addEventListener('click', copyTranscript);
    if (clearBtn) clearBtn.addEventListener('click', clearAll);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);
    window.addEventListener('load', sizeCanvas);
    if (typeof window.ResizeObserver === 'function') {
      try { new window.ResizeObserver(sizeCanvas).observe(canvas); } catch (err) {}
    }
    if (typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', function (event) {
        reduced = event.matches;
        if (phase !== 'recording') drawIdle(settled);
      });
    }

    setPhase('idle');
    if (placeholderEl) placeholderEl.textContent = IDLE_HINT;

    return api;
  }

  /* ------------------------------------------------------------ reveals */

  function initReveals() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) {
        el.classList.add('is-visible');
      });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    Array.prototype.forEach.call(items, function (el) {
      observer.observe(el);
    });
  }

  /* --------------------------------------------------------------- init */

  function init() {
    if (intro) {
      if (reduceMotion.matches || readSeen()) {
        intro.hidden = true;
        root.classList.remove('intro-pending');
      } else {
        try {
          startIntro();
        } catch (err) {
          /* Never let the intro block the page. */
          intro.hidden = true;
          root.classList.remove('intro-pending');
          document.body.classList.remove('intro-active');
          setPageInert(false);
        }
      }
    }

    if (skipBtn) skipBtn.addEventListener('click', dismissIntro);
    if (playBtn) playBtn.addEventListener('click', dismissIntro);

    /* Turning on "reduce motion" mid-intro ends it immediately. */
    var onMotionChange = function (event) {
      if (intro && !intro.hidden && event.matches) dismissIntro();
    };
    if (typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', onMotionChange);
    } else if (typeof reduceMotion.addListener === 'function') {
      reduceMotion.addListener(onMotionChange);
    }

    initReveals();
    createRecorder(document.getElementById('heroRecorder'), { toggle: true });
    createRecorder(document.getElementById('demoApp'), { full: true });

    /* Lazy-load 3D AI Orb HeroBackground */
    var heroBgContainer = document.getElementById('heroBgContainer');
    if (heroBgContainer) {
      var loadHero3D = function () {
        import('./HeroBackground.js')
          .then(function (module) {
            var HeroBackgroundClass = module.HeroBackground || module.default;
            if (HeroBackgroundClass) {
              var bgInstance = new HeroBackgroundClass({
                container: heroBgContainer
              });
              bgInstance.init();
              window.__talkityHeroBg = bgInstance;
            }
          })
          .catch(function (err) {
            console.warn('[Talkity] HeroBackground lazy-load fallback:', err);
            heroBgContainer.classList.add('hero-bg--fallback');
          });
      };

      if (window.requestIdleCallback) {
        window.requestIdleCallback(loadHero3D, { timeout: 1200 });
      } else {
        window.setTimeout(loadHero3D, 80);
      }
    }

    var year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());

    window.__talkityReady = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
