using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Talkity Desktop — native Windows dictation client.
// Protocol: PROTOCOL_SPEC.md (WebSocket Protocol v1.0.0, preserved unchanged).
//
// TalkityWsClient below is the Phase 3 protocol implementation and is kept as-is.
// The application shell above it (dictation, HUD, tray, settings) was rebuilt
// around it so the protocol behaviour and its tests stay stable.

namespace TalkityDesktop
{
    // ===========================================================
    // Application shell
    // ===========================================================

    internal static class TalkityApp
    {
        private const string MutexName = "TalkityDesktop.SingleInstance";

        [STAThread]
        public static void Main(string[] args)
        {
            // This build targets the .NET Framework 4.0 reference assemblies, where
            // ServicePointManager.SecurityProtocol defaults to Ssl3 | Tls. The backend
            // only accepts TLS 1.2+, so every HTTPS and WSS call fails before a request
            // is even sent: HTTP surfaces WebExceptionStatus.SecureChannelFailure and
            // ClientWebSocket reports WebSocketError.Success with the real cause hidden
            // in its inner exception. That single defect produced "Transcription
            // failed", the silent loss of text enhancement, and the never-ending
            // "Disconnected - reconnecting" HUD.
            //
            // The Tls12 enum member does not exist in the 4.0 reference assemblies, so
            // the numeric value is used. Opting in with |= keeps any protocols the OS
            // has already enabled.
            try
            {
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // Tls12
            }
            catch (NotSupportedException)
            {
                // Older runtimes reject the value; nothing more can be done here.
            }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    TalkityLog.Info("Another instance is already running; exiting");
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
                {
                    TalkityLog.Error("UI exception: " + e.Exception.GetType().Name);
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
                {
                    TalkityLog.Error("Unhandled exception: " + e.ExceptionObject.GetType().Name);
                };

                TalkityController controller = new TalkityController();
                controller.Start(args);
                Application.Run(controller);
            }
        }

        /// <summary>
        /// Describe a microphone/recognition error for display in the HUD.
        /// </summary>
        public static string DescribeMicError(Exception ex)
        {
            if (ex is InvalidOperationException) return "no microphone found - connect one and restart Talkity";
            if (ex is ArgumentException) return "recognition language not installed";
            if (ex is PlatformNotSupportedException) return "speech recognition is not supported on this system";
            return "speech recognition unavailable";
        }

        /// <summary>
        /// Sanitize exception messages so they never contain audio content or
        /// sensitive details; only the exception type and a short sanitized
        /// message are logged.
        /// </summary>
        public static string SanitizeExceptionMessage(Exception ex)
        {
            if (ex == null) return "";
            string msg = ex.Message ?? "";
            if (msg.Length > 200) msg = msg.Substring(0, 200) + "...";
            return msg;
        }
    }

    /// <summary>
    /// Owns the application lifecycle: dictation state machine, speech engine,
    /// hotkey, text insertion, and the bridge to the protocol client. It is an
    /// invisible message-only context that hosts the visible windows.
    /// </summary>
    internal sealed class TalkityController : ApplicationContext
    {
        private const int WM_HOTKEY = 0x0312;
        private const int HOTKEY_ID = 9001;
        private const byte VK_CONTROL = 0x11;
        private const byte VK_V = 0x56;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const int MAX_TEXT = 5000;

        // How long a target is given to consume Ctrl+V before we decide the paste
        // did not land. keybd_event returns before the target processes the input,
        // so this wait is what makes "inserted" mean something observable.
        private const int PasteSettleMs = 250;
        // How long the previous clipboard contents are held back after a paste that
        // looked successful, so a slow target still reads our text.
        private const int ClipboardRestoreDelayMs = 1500;
        private const int ClipboardRetries = 4;

        private const int SW_RESTORE = 9;

        // Results below this confidence are not inserted. The legacy desktop recognizer
        // emits fluent-looking nonsense at 0.01-0.08 when it cannot model the audio, and
        // pasting that into the user's document is worse than reporting a miss.
        private const float MinConfidence = 0.35f;

        [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

        private enum DictationState { Idle, Listening, Paused, Processing, Inserting }

        private readonly TalkitySettings _settings;
        private readonly TalkityHistory _history = new TalkityHistory();
        private readonly object _injectionLock = new object();
        private readonly object _stateLock = new object();

        private TalkityHud _hud;
        private TalkityMainForm _main;
        private NotifyIcon _tray;
        private SpeechRecognitionEngine _recognizer;
        private TalkityWsClient _ws;
        private DictationMessageWindow _hotkeyWindow;
        private TalkityWhisperRecorder _whisperRecorder;
        private TalkityWhisperClient _whisperClient;

        private DictationState _state = DictationState.Idle;
        private DateTime _startedAt;

        // Recognition results are collected per session. _session is incremented
        // every time listening starts or is cancelled, and every recognition
        // callback captures the value it saw; a callback whose session no longer
        // matches is stale and is dropped. This is what stops a result from a
        // session that was stopped from leaking into the next one.
        private readonly StringBuilder _speech = new StringBuilder();
        private int _session;
        private int _lowConfidenceRejects;
        private readonly ManualResetEvent _recognitionDrained = new ManualResetEvent(true);

        private IntPtr _targetWindow = IntPtr.Zero;
        private string _targetTitle = "";
        private bool _micReady;
        private string _micDetail = "";
        private bool _connected;
        private string _clientId;

        // The transcript of the most recent dictation, kept so a failed insertion
        // can be retried or copied without dictating again.
        private string _lastTranscript = "";

        public TalkityController()
        {
            _settings = TalkitySettings.Load();
            _history.Load();
            _clientId = "desktop-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            _whisperClient = new TalkityWhisperClient(_settings.Endpoint, _clientId, _settings.WhisperLanguage);
        }

        public void Start(string[] args)
        {
            _hotkeyWindow = new DictationMessageWindow(OnHotkey);
            RegisterCurrentHotkey();

            _hud = new TalkityHud();
            _hud.PlaceAt(_settings.HudX, _settings.HudY);
            _hud.PositionCommitted += delegate { SaveHudPosition(); };
            _hud.ActionRequested += delegate
            {
                lock (_stateLock)
                {
                    if (_state == DictationState.Listening) TogglePause();
                    else ToggleDictation();
                }
            };
            if (_settings.ShowHud) _hud.Show();
            _hud.SetConnected(false);

            _main = new TalkityMainForm();
            _main.DictateRequested += delegate { ToggleDictation(); };
            _main.CopyTranscriptRequested += delegate { CopyLastTranscript(); };
            _main.SettingsRequested += delegate { OpenSettings(); };
            _main.ClearHistoryRequested += delegate { ClearHistory(); };
            _main.ReinsertRequested += delegate(object s, HistoryEntry e) { Reinsert(e); };
            _main.SetHint("Hotkey: " + _settings.Hotkey + "  -  press it in any application to dictate.");

            bool background = false;
            if (args != null)
                for (int i = 0; i < args.Length; i++)
                    if (args[i] == "--background") background = true;
            if (!background)
            {
                _main.Show();
            }
            else
            {
                // Autostart path: the main window stays hidden, but WebSocket and
                // injection callbacks marshal onto the UI thread with BeginInvoke,
                // which requires a window handle. Reading Handle creates it without
                // showing the form. Without this the process crashed on the first
                // connection whenever it was started with --background.
                IntPtr handle = _main.Handle;
                if (handle == IntPtr.Zero)
                    TalkityLog.Warn("Main window handle could not be created");
            }

            BuildTray();
            InitSpeech();
            RefreshHistoryView();
            StartSocket();
            TalkityLog.Info("Talkity started, clientId=" + _clientId);
        }

        // ---- tray ----

        private void BuildTray()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Show Talkity", null, delegate { _main.Show(); _main.Activate(); });
            menu.Items.Add("Show dictation indicator", null, delegate { _hud.Show(); });
            menu.Items.Add("Hide dictation indicator", null, delegate { _hud.Hide(); });
            menu.Items.Add("-");
            menu.Items.Add("Start / stop dictation", null, delegate { ToggleDictation(); });
            menu.Items.Add("Pause dictation", null, delegate { TogglePause(); });
            menu.Items.Add("Copy last transcript", null, delegate { CopyLastTranscript(); });
            menu.Items.Add("Settings", null, delegate { OpenSettings(); });
            menu.Items.Add("-");
            menu.Items.Add("Exit", null, delegate { Shutdown(); });

            _tray = new NotifyIcon();
            _tray.Icon = System.Drawing.SystemIcons.Application;
            _tray.Text = "Talkity - starting";
            _tray.ContextMenuStrip = menu;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { _main.Show(); _main.Activate(); };
        }

        // ---- speech ----

        private void InitSpeech()
        {
            // Re-entrant on purpose: switching engines rewrites _recognizer, and
            // leaving the previous engine bound would keep the microphone open.
            DisposeRecognizer();
            try
            {
                // Use the selected transcription engine
                if (_settings.TranscriptionEngine == "whisper")
                {
                    _micReady = true;
                    _micDetail = "Whisper engine selected";
                    TalkityLog.Info("Transcription engine: Whisper (server-side)");
                    _recognizer = null;
                }
                else
                {
                    // System.Speech recognizer (default behavior)
                    RecognizerInfo info = SelectRecognizer(_settings.Language);
                    if (info == null)
                    {
                        _micReady = false;
                        _micDetail = "no recognizer installed for " + _settings.Language +
                            " - install a matching Windows speech language";
                        TalkityLog.Warn("No installed recognizer matches " + _settings.Language);
                    }
                    else
                    {
                        _recognizer = new SpeechRecognitionEngine(info);
                        _recognizer.SetInputToDefaultAudioDevice();
                        _recognizer.LoadGrammar(new DictationGrammar());

                        TalkityLog.Info("Speech session started, recognizer=" + info.Id +
                            ", culture=" + info.Culture.Name + ", userLanguage=" + _settings.Language);
                        _recognizer.SpeechRecognized += OnSpeechRecognized;
                        _recognizer.RecognizeCompleted += OnRecognizeCompleted;

                        _micReady = true;
                        _micDetail = info.Culture.Name;
                        TalkityLog.Info("Recognizer ready, culture=" + info.Culture.Name);
                    }
                }
            }
            catch (Exception ex)
            {
                _micReady = false;
                _micDetail = DescribeMicError(ex);
                TalkityLog.Warn("Microphone unavailable: " + ex.GetType().Name);
            }
            _main.SetMicrophone(_micReady, _micDetail);
        }

        /// <summary>
        /// Release the System.Speech engine. Safe to call when Whisper is selected and
        /// no engine was ever created.
        /// </summary>
        private void DisposeRecognizer()
        {
            if (_recognizer == null) return;
            try { _recognizer.Dispose(); }
            catch (Exception ex) { TalkityLog.Warn("Recognizer dispose failed: " + ex.GetType().Name); }
            _recognizer = null;
        }

        /// <summary>
        /// Pick an installed recognizer whose culture matches the requested language.
        /// Constructing SpeechRecognitionEngine directly from a CultureInfo does not
        /// verify that a recognizer for it exists; when none does, the engine either
        /// throws or decodes against the wrong acoustic model, which is the source of
        /// the garbled transcripts. Matching against InstalledRecognizers() first makes
        /// the failure explicit and the selection deterministic.
        /// </summary>
        internal static RecognizerInfo SelectRecognizer(string requestedLanguage)
        {
            System.Collections.ObjectModel.ReadOnlyCollection<RecognizerInfo> installed;
            try { installed = SpeechRecognitionEngine.InstalledRecognizers(); }
            catch (Exception ex)
            {
                TalkityLog.Warn("Could not enumerate recognizers: " + ex.GetType().Name);
                return null;
            }

            System.Globalization.CultureInfo wanted = null;
            try { if (!string.IsNullOrEmpty(requestedLanguage)) wanted = new System.Globalization.CultureInfo(requestedLanguage); }
            catch { wanted = null; }

            RecognizerInfo sameLanguage = null;
            for (int i = 0; i < installed.Count; i++)
            {
                RecognizerInfo candidate = installed[i];
                if (wanted != null && candidate.Culture.Equals(wanted)) return candidate;
                if (wanted != null && sameLanguage == null &&
                    string.Equals(candidate.Culture.TwoLetterISOLanguageName,
                                  wanted.TwoLetterISOLanguageName,
                                  StringComparison.OrdinalIgnoreCase))
                    sameLanguage = candidate;
            }
            // A recognizer for the same language but a different region is usable and
            // far better than none. Anything else is reported as unavailable rather
            // than silently bound, because a mismatched engine yields nonsense text.
            return sameLanguage;
        }

        private void OnSpeechRecognized(object sender, SpeechRecognizedEventArgs e)
        {
            int sessionAtEntry;
            lock (_stateLock) { sessionAtEntry = _session; }

            if (e.Result == null)
            {
                TalkityLog.Info("Recognition result empty, session=" + sessionAtEntry);
                return;
            }

            RecognitionResult result = e.Result;
            string text = result.Text;
            // Audio.Duration is the one property that is cheap and safe to log; the
            // text itself is never written, only its length.
            TimeSpan duration = TimeSpan.Zero;
            float confidence = 0f;
            try { if (result.Audio != null) duration = result.Audio.Duration; } catch { }
            try { confidence = result.Confidence; } catch { }
            TalkityLog.Info("Recognition final, session=" + sessionAtEntry +
                ", chars=" + (text == null ? 0 : text.Length) +
                ", confidence=" + confidence.ToString("F2", System.Globalization.CultureInfo.InvariantCulture) +
                ", audioMs=" + (int)duration.TotalMilliseconds);

            // A result the acoustic model cannot justify must not reach the document.
            // The surviving session guard below still applies to every kept result.
            if (confidence > 0f && confidence < MinConfidence)
            {
                lock (_stateLock)
                {
                    if (sessionAtEntry != _session) return;
                    _lowConfidenceRejects++;
                }
                TalkityLog.Warn("Discarded low-confidence result (" +
                    confidence.ToString("F2", System.Globalization.CultureInfo.InvariantCulture) +
                    "), not inserted; the recognizer could not model this audio");
                return;
            }

            string trimmed = text == null ? "" : text.Trim();

            lock (_stateLock)
            {
                // A callback carries the session it was raised for. If the user has
                // since stopped and started again, this result belongs to the old
                // session and appending it would corrupt the new transcript.
                if (!DictationRules.AcceptResult(sessionAtEntry, _session, StateName(_state), trimmed)) return;
                if (_speech.Length > 0) _speech.Append(' ');
                _speech.Append(trimmed);
            }
        }

        private void OnRecognizeCompleted(object sender, RecognizeCompletedEventArgs e)
        {
            // RecognizeAsyncStop does not finish synchronously: the engine raises this
            // once it has delivered every result it is going to deliver. FinishListening
            // waits on _recognitionDrained, so the transcript is read only after that.
            if (e.Error != null)
                TalkityLog.Warn("Recognition ended with error: " + e.Error.GetType().Name + " - " + SanitizeExceptionMessage(e.Error));
            else if (e.Cancelled)
                TalkityLog.Info("Recognition cancelled");
            _recognitionDrained.Set();
        }

        public static string DescribeMicError(Exception ex)
        {
            if (ex is InvalidOperationException) return "no microphone found - connect one and restart Talkity";
            if (ex is ArgumentException) return "recognition language not installed";
            if (ex is PlatformNotSupportedException) return "speech recognition is not supported on this system";
            return "speech recognition unavailable";
        }

        /// <summary>
        /// Sanitize exception messages so they never contain audio content or
        /// sensitive details; only the exception type and a short sanitized
        /// message are logged.
        /// </summary>
        public static string SanitizeExceptionMessage(Exception ex)
        {
            if (ex == null) return "";
            string msg = ex.Message ?? "";
            if (msg.Length > 200) msg = msg.Substring(0, 200) + "...";
            return msg;
        }

        // ---- dictation state machine ----

        private void OnHotkey()
        {
            // The message pump delivers this on the UI thread, one at a time,
            // so a held key cannot start overlapping sessions.
            ToggleDictation();
        }

        private void ToggleDictation()
        {
            lock (_stateLock)
            {
                // Processing and inserting are one-shot transitions; a second hotkey
                // during either must not start another session or insert twice.
                if (DictationRules.TriggerIgnored(StateName(_state))) return;
                if (_state == DictationState.Idle) BeginListening();
                else FinishListening();
            }
        }

        private void TogglePause()
        {
            lock (_stateLock)
            {
                if (_state == DictationState.Listening)
                {
                    _state = DictationState.Paused;
                    StopRecognition();
                    if (_settings.SoundCues) { try { Console.Beep(400, 120); } catch { } }
                    _hud.ApplyState(HudState.Paused, "");
                    _main.SetDictationState("Paused", false);
                    _tray.Text = "Talkity - paused";
                }
                else if (_state == DictationState.Paused)
                {
                    _state = DictationState.Listening;
                    if (_settings.SoundCues) { try { Console.Beep(520, 90); Console.Beep(780, 110); } catch { } }
                    _hud.ApplyState(HudState.Listening, "");
                    _main.SetDictationState("Listening...", true);
                    _tray.Text = "Talkity - listening";
                    StartRecognition();
                }
            }
        }

        private void StartRecognition()
        {
            // A missing engine means InitSpeech was not re-run after the selected
            // transcription engine changed. Report it instead of dereferencing null
            // (which surfaced as "Could not start dictation: NullReferenceException"
            // and left the session stuck in Listening).
            if (_recognizer == null)
            {
                _micReady = false;
                _micDetail = "speech recognizer unavailable";
                TalkityLog.Warn("Speech recognizer unavailable; press the hotkey again after restarting Talkity");
                return;
            }
            _recognitionDrained.Reset();
            _recognizer.RecognizeAsync(RecognizeMode.Multiple);
        }

        /// <summary>
        /// Ask the engine to stop and wait until it has raised RecognizeCompleted, so
        /// every final result it intends to deliver has already been collected. The
        /// wait is bounded: a wedged engine must not freeze the hotkey.
        /// </summary>
        private void StopRecognition()
        {
            if (_recognizer == null)
            {
                _recognitionDrained.Set();
                return;
            }
            _recognitionDrained.Reset();
            try { _recognizer.RecognizeAsyncStop(); }
            catch (InvalidOperationException)
            {
                // Nothing was running, so no completion event will arrive.
                _recognitionDrained.Set();
                return;
            }
            if (!_recognitionDrained.WaitOne(1500))
                TalkityLog.Warn("Recognition did not finish within the stop timeout");
        }

        private void BeginListening()
        {
            if (!_micReady)
            {
                _hud.ApplyState(HudState.Error, "No microphone");
                _main.SetDictationState("Cannot dictate: " + _micDetail, false);
                return;
            }

            // Capture the target BEFORE any Talkity window is touched. The hotkey
            // arrives while the user's application is still foreground; showing or
            // activating anything of ours first would make us capture ourselves.
            IntPtr target = GetForegroundWindow();
            string title = ReadTitle(target);
            if (IsOwnWindow(target))
            {
                target = IntPtr.Zero;
                title = "";
                TalkityLog.Info("Hotkey pressed while Talkity was foreground; no external target captured");
            }

            _state = DictationState.Listening;
            _session++;
            _startedAt = DateTime.Now;
            _speech.Clear();
            _lowConfidenceRejects = 0;
            _targetWindow = target;
            _targetTitle = title;

            Stopwatch captureStart = Stopwatch.StartNew();
            if (_settings.SoundCues) { try { Console.Beep(520, 90); Console.Beep(780, 110); } catch { } }
            _hud.ApplyState(HudState.Listening, "");
            _main.SetDictationState("Listening...", true);
            _tray.Text = "Talkity - listening";
            try
            {
                if (_settings.TranscriptionEngine == "whisper")
                {
                    StartWhisperRecording(target, title);
                    // Includes the start cue and WinMM device open. Logged so a long
                    // delay (and the first-word loss it implies) is visible.
                    TalkityLog.Info("Whisper capture start latency: " + captureStart.ElapsedMilliseconds + " ms" +
                        (_settings.SoundCues ? " (includes start cue)" : ""));
                }
                else
                {
                    StartRecognition();
                }
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("Could not start dictation: " + ex.GetType().Name);
                _state = DictationState.Idle;
                _recognitionDrained.Set();
                _hud.ApplyState(HudState.Error, "Microphone error");
            }
        }

        private void FinishListening()
        {
            _state = DictationState.Processing;
            int session = _session;
            if (_settings.SoundCues) { try { Console.Beep(780, 90); Console.Beep(520, 110); } catch { } }
            _hud.ApplyState(HudState.Processing, "");
            _main.SetDictationState("Processing...", false);

            IntPtr target = _targetWindow;
            string title = _targetTitle;
            bool enhance = _settings.EnhanceText;
            string tone = _settings.Tone;
            string endpoint = _settings.Endpoint;

            ThreadPool.QueueUserWorkItem(delegate
            {
                // --- Phase A: capture/stop recognition ---
                if (_settings.TranscriptionEngine == "whisper")
                {
                    // Whisper path: stop recording and send WAV to /api/transcribe
                    byte[] wav = StopWhisperRecording();
                    if (wav == null || wav.Length < 500)
                    {
                        // No usable audio recorded
                        ReportResult(session, "", "", false, false, "Nothing recognized", title);
                        return;
                    }

                    // Send to server for Whisper transcription
                    TranscriptionResult result = _whisperClient.Transcribe(wav);
                    if (result == null || !result.Success)
                    {
                        string failReason = (result != null && !string.IsNullOrEmpty(result.ErrorMessage))
                            ? "Transcription failed: " + result.ErrorMessage
                            : "Transcription failed - check your connection and try again.";
                        ReportResult(session, "", "", false, false, failReason, title);
                        return;
                    }

                    string raw = result.RawText ?? "";
                    // Prefer the server's meaning-preserving normalization (dictionary
                    // spelling plus punctuation). Older servers omit it; fall back to the
                    // local formatter. Never use the server's "clean" text here: it
                    // deletes filler words, which changes what the speaker said.
                    string normalized = TalkityTextFormatter.Format(
                        !string.IsNullOrEmpty(result.NormalizedText) ? result.NormalizedText : raw);
                    string finalText = normalized;
                    bool enhanced = false;

                    // Optionally polish further via /api/polish if enhance is enabled.
                    // If that request fails, keep the normalized transcript rather than
                    // dropping back to unformatted raw text.
                    if (enhance && finalText.Length > 0)
                    {
                        PolishResult polished = TalkityPolish.Enhance(endpoint, normalized, tone);
                        finalText = DictationRules.TranscriptAfterEnhancement(normalized, polished.Text, polished.Enhanced);
                        enhanced = polished.Enhanced && finalText != normalized;
                    }

                    // --- Phase B: insert or report ---
                    lock (_stateLock)
                    {
                        if (session != _session) return;
                        _state = DictationState.Inserting;
                    }

                    bool inserted = false;
                    string failure = "";
                    if (finalText.Length == 0)
                    {
                        failure = "Nothing recognized";
                    }
                    else
                    {
                        inserted = InsertText(target, finalText);
                        if (!inserted) failure = "Could not insert into the target window. The text is on the clipboard - paste it with Ctrl+V.";
                    }
                    ReportResult(session, raw, finalText, enhanced, inserted, failure, title);
                    return;
                }
                else
                {
                    // System.Speech path
                    StopRecognition();

                    string raw;
                    int rejects;
                    lock (_stateLock)
                    {
                        // A newer session means the user restarted dictation before this
                        // pass finished. Its results belong to that session, not to us.
                        if (session != _session) return;
                        raw = _speech.ToString().Trim();
                        rejects = _lowConfidenceRejects;
                    }

                    string finalText = raw;
                    bool enhanced = false;
                    if (enhance && raw.Length > 0)
                    {
                        PolishResult polished = TalkityPolish.Enhance(endpoint, raw, tone);
                        finalText = DictationRules.TranscriptAfterEnhancement(raw, polished.Text, polished.Enhanced);
                        enhanced = finalText != raw;
                    }

                    lock (_stateLock)
                    {
                        if (session != _session) return;
                        _state = DictationState.Inserting;
                    }

                    bool inserted = false;
                    string failure = "";
                    if (finalText.Length == 0)
                    {
                        // Distinguish "the microphone heard nothing" from "the recognizer
                        // heard speech it could not model", which need different advice.
                        failure = rejects > 0
                            ? "Heard speech but could not transcribe it confidently - switch to Whisper"
                            : "Nothing recognized";
                    }
                    else
                    {
                        inserted = InsertText(target, finalText);
                        if (!inserted) failure = "Could not insert into the target window. The text is on the clipboard - paste it with Ctrl+V.";
                    }
                    ReportResult(session, raw, finalText, enhanced, inserted, failure, title);
                }
            });
        }

        // ---- Whisper recorder helpers ----

        /// <summary>
        /// Start Whisper microphone recording via WinMM capture.
        /// </summary>
        private void StartWhisperRecording(IntPtr target, string title)
        {
            // Set up microphone flag for UI status (Whisper path doesn't need the C# recognizer)
            _micReady = true;

            _whisperRecorder = new TalkityWhisperRecorder();
            if (!_whisperRecorder.StartRecording())
            {
                _state = DictationState.Idle;
                _recognitionDrained.Set();
                _hud.ApplyState(HudState.Error, "Microphone error");
                _main.SetDictationState("Could not start microphone recording.", false);
                return;
            }

            _recognitionDrained.Set(); // signal so any waiting StopRecognition doesn't block
        }

        /// <summary>
        /// Stop Whisper recording and return WAV bytes, or null on failure.
        /// </summary>
        private byte[] StopWhisperRecording()
        {
            if (_whisperRecorder == null) return null;

            try
            {
                return _whisperRecorder.StopRecording();
            }
            finally
            {
                _whisperRecorder.Dispose();
                _whisperRecorder = null;
            }
        }

        private void ReportResult(int session, string raw, string finalText, bool enhanced, bool inserted, string failure, string title)
        {
            if (_main.IsDisposed) return;
            _main.BeginInvoke(new Action(delegate
            {
                lock (_stateLock)
                {
                    // A newer dictation has already taken over; reporting this one
                    // would clobber its state and could mark it inserted.
                    if (session != _session) return;
                    _state = DictationState.Idle;
                }
                _lastTranscript = finalText.Length > 0 ? finalText : raw;

                if (finalText.Length == 0)
                {
                    _hud.ApplyState(HudState.Error, failure);
                    _main.SetDictationState(failure + ". Press " + _settings.Hotkey + " to try again.", false);
                }
                else if (inserted)
                {
                    string note = enhanced ? "Inserted (enhanced)" : "Inserted";
                    _hud.ApplyState(HudState.Inserted, note);
                    _main.SetDictationState(note + " into " + (title.Length == 0 ? "the active app" : title), false);
                }
                else
                {
                    // Insertion failed, but the transcript is intact: it stays visible
                    // and on the clipboard, and the user gets an explicit way to retry.
                    _hud.ApplyState(HudState.Error, "Copied to clipboard");
                    _main.SetDictationState(failure, false);
                }
                _main.SetTranscript(_lastTranscript);
                _tray.Text = _connected ? "Talkity - connected" : "Talkity - offline";

                if (_settings.KeepHistory && finalText.Length > 0)
                {
                    HistoryEntry entry = new HistoryEntry();
                    entry.Timestamp = NowMs();
                    entry.Text = finalText;
                    entry.Enhanced = enhanced;
                    entry.Inserted = inserted;
                    entry.TargetApp = title;
                    _history.Add(entry, _settings.HistoryLimit);
                    RefreshHistoryView();
                }

                // Return the HUD to its resting state shortly after feedback.
                System.Windows.Forms.Timer reset = new System.Windows.Forms.Timer();
                reset.Interval = 2500;
                reset.Tick += delegate { reset.Stop(); reset.Dispose(); if (_state == DictationState.Idle) _hud.ApplyState(HudState.Idle, "Talkity - " + _settings.Hotkey); };
                reset.Start();
            }));
        }

        // ---- text insertion ----

        /// <summary>
        /// Insert text into the captured target window. Returns false when the paste
        /// could not be delivered; the text is then left on the clipboard so the user
        /// can paste it manually. Previous clipboard contents are restored only after
        /// the target has had time to read them, and only if Talkity still owns them.
        ///
        /// Serialized by _injectionLock so two insertions can never interleave their
        /// clipboard and keystroke steps.
        /// </summary>
        private bool InsertText(IntPtr target, string text)
        {
            if (text.Length > MAX_TEXT) text = text.Substring(0, MAX_TEXT);
            lock (_injectionLock)
            {
                if (target == IntPtr.Zero || !IsWindow(target))
                {
                    TalkityLog.Warn("No valid target window; text placed on clipboard only");
                    ClipboardSet(text);
                    return false;
                }
                if (IsOwnWindow(target))
                {
                    // Never type into ourselves. The transcript is already on screen.
                    TalkityLog.Warn("Target is a Talkity window; text placed on clipboard only");
                    ClipboardSet(text);
                    return false;
                }

                string previous = "";
                bool hadText = ClipboardGet(out previous);

                if (!ClipboardSet(text))
                {
                    TalkityLog.Warn("Clipboard unavailable after retries; text kept in the Talkity window");
                    return false;
                }

                bool focused = FocusWindow(target);
                if (!focused)
                {
                    // The transcript is on the clipboard and stays there. Restoring the
                    // old contents here would throw away the only copy the user can paste.
                    TalkityLog.Warn("Target window would not take focus; text left on clipboard");
                    return false;
                }

                SendPaste();

                // Sending the keystroke does not mean the target handled it. Give it
                // time, then check that focus did not move away mid-paste. A target
                // that accepts Ctrl+V leaves the clipboard untouched, so clipboard
                // contents are NOT a signal of success and are not read here.
                Thread.Sleep(PasteSettleMs);
                bool stillThere = GetForegroundWindow() == target;

                if (stillThere && hadText)
                    ScheduleClipboardRestore(previous, text);
                if (_settings.SoundCues && stillThere) { try { Console.Beep(900, 70); } catch { } }
                if (!stillThere)
                    TalkityLog.Warn("Focus left the target before the paste settled; text left on clipboard");
                return stillThere;
            }
        }

        /// <summary>
        /// Bring a window to the foreground. Windows blocks SetForegroundWindow from a
        /// process that is not the foreground process; attaching this thread's input
        /// queue to the CURRENT foreground thread is the documented way to be allowed
        /// through. The target is also restored if minimized and raised explicitly,
        /// because SetForegroundWindow alone does not un-minimize or reorder Z-order.
        /// </summary>
        private static bool FocusWindow(IntPtr target)
        {
            if (!IsWindow(target) || !IsWindowVisible(target)) return false;

            IntPtr foreground = GetForegroundWindow();
            uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
            uint ourThread = GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (foregroundThread != 0 && foregroundThread != ourThread)
                    attached = AttachThreadInput(ourThread, foregroundThread, true);
                if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
                BringWindowToTop(target);
                SetForegroundWindow(target);
            }
            finally
            {
                if (attached) AttachThreadInput(ourThread, foregroundThread, false);
            }
            Thread.Sleep(60);
            return GetForegroundWindow() == target;
        }

        private static void SendPaste()
        {
            keybd_event(VK_CONTROL, 0, 0, 0);
            Thread.Sleep(20);
            keybd_event(VK_V, 0, 0, 0);
            Thread.Sleep(20);
            keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
            Thread.Sleep(20);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
        }

        private bool IsOwnWindow(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return false;
            if (_hud != null && hWnd == _hud.Handle) return true;
            if (_main != null && hWnd == _main.Handle) return true;
            if (_hotkeyWindow != null && hWnd == _hotkeyWindow.Handle) return true;
            return false;
        }

        // Clipboard access must happen on an STA thread that pumps messages. The UI
        // thread is that thread; the worker that runs insertion is not, so every
        // clipboard call is marshalled across and retried while another application
        // holds the clipboard open.

        private bool ClipboardGet(out string text)
        {
            string read = null;
            bool ok = RunOnUi(delegate
            {
                for (int attempt = 0; attempt < ClipboardRetries; attempt++)
                {
                    try
                    {
                        if (Clipboard.ContainsText()) read = Clipboard.GetText();
                        return;
                    }
                    catch (ExternalException) { Thread.Sleep(40 * (attempt + 1)); }
                }
                TalkityLog.Warn("Could not read the clipboard; previous contents will not be restored");
            });
            text = read ?? "";
            return ok && read != null;
        }

        private bool ClipboardSet(string text)
        {
            bool placed = false;
            RunOnUi(delegate
            {
                for (int attempt = 0; attempt < ClipboardRetries; attempt++)
                {
                    try { Clipboard.SetText(text); placed = true; return; }
                    catch (ExternalException) { Thread.Sleep(40 * (attempt + 1)); }
                }
            });
            return placed;
        }

        /// <summary>
        /// Put the previous clipboard contents back, but only once the target has had
        /// a realistic chance to read what we placed there, and only if the clipboard
        /// still holds exactly our text. If the user copied something else in the
        /// meantime, their copy wins.
        /// </summary>
        private void ScheduleClipboardRestore(string previous, string ours)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                Thread.Sleep(ClipboardRestoreDelayMs);
                try
                {
                    RunOnUi(delegate
                    {
                        try
                        {
                            if (Clipboard.ContainsText() && Clipboard.GetText() == ours)
                                Clipboard.SetText(previous);
                        }
                        catch (ExternalException) { TalkityLog.Warn("Clipboard restore skipped; clipboard busy"); }
                    });
                }
                catch { }
            });
        }

        private bool RunOnUi(Action action)
        {
            try
            {
                if (_main == null || _main.IsDisposed) { action(); return true; }
                if (_main.InvokeRequired) _main.Invoke(action);
                else action();
                return true;
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("UI marshalling failed: " + ex.GetType().Name);
                return false;
            }
        }

        private void Reinsert(HistoryEntry entry)
        {
            if (entry == null || string.IsNullOrEmpty(entry.Text)) return;
            // Reinsertion is explicit, so the current foreground window is the
            // intended target rather than one captured earlier.
            IntPtr target = GetForegroundWindow();
            if (IsOwnWindow(target))
            {
                ClipboardSet(entry.Text);
                _hud.ApplyState(HudState.Error, "Copied to clipboard");
                _main.SetDictationState("Talkity is the active window, so the text was copied instead. Click the app you want and press Ctrl+V.", false);
                return;
            }
            bool ok = InsertText(target, entry.Text);
            _hud.ApplyState(ok ? HudState.Inserted : HudState.Error, ok ? "Inserted" : "Copied to clipboard");
        }

        private void CopyLastTranscript()
        {
            if (string.IsNullOrEmpty(_lastTranscript)) return;
            bool ok = ClipboardSet(_lastTranscript);
            _hud.ApplyState(ok ? HudState.Inserted : HudState.Error, ok ? "Copied" : "Copy failed");
            _main.SetDictationState(ok
                ? "Copied. Click the app you want and press Ctrl+V."
                : "Could not reach the clipboard. Select the text in the transcript box and copy it manually.", false);
        }

        // ---- settings ----

        private void OpenSettings()
        {
            string previousEngine = _settings.TranscriptionEngine;
            string previousEndpoint = _settings.Endpoint;
            string previousWhisperLanguage = _settings.WhisperLanguage;
            using (TalkitySettingsForm dialog = new TalkitySettingsForm(_settings))
            {
                if (dialog.ShowDialog(_main) != DialogResult.OK) return;
            }
            _settings.Save();
            _settings.ApplyStartupRegistration();
            RegisterCurrentHotkey();
            if (_settings.ShowHud) _hud.Show(); else _hud.Hide();
            _main.SetHint("Hotkey: " + _settings.Hotkey + "  -  press it in any application to dictate.");
            // Rebind the engine when the transcription engine changed. Without this the
            // controller kept _micReady = true from a Whisper session while _recognizer
            // stayed null (or kept a recognizer the user had just switched away from).
            if (!string.Equals(previousEngine, _settings.TranscriptionEngine, StringComparison.Ordinal))
            {
                TalkityLog.Info("Transcription engine changed to " + _settings.TranscriptionEngine);
                InitSpeech();
            }
            // The Whisper client binds its base URL and language once, so rebuild it
            // when either changes; otherwise requests keep using the old values until
            // the app restarts.
            if (!string.Equals(previousEndpoint, _settings.Endpoint, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(previousWhisperLanguage, _settings.WhisperLanguage, StringComparison.Ordinal))
            {
                if (_whisperClient != null) _whisperClient.Dispose();
                _whisperClient = new TalkityWhisperClient(_settings.Endpoint, _clientId, _settings.WhisperLanguage);
                TalkityLog.Info("Transcription endpoint/language changed; WebSocket endpoint applies on restart");
            }
            // The System.Speech locale still applies on next launch; the Whisper
            // language above takes effect immediately.
            TalkityLog.Info("Settings saved");
        }

        private void RegisterCurrentHotkey()
        {
            UnregisterHotKey(_hotkeyWindow.Handle, HOTKEY_ID);
            uint modifiers, key;
            _settings.ResolveHotkey(out modifiers, out key);
            if (!RegisterHotKey(_hotkeyWindow.Handle, HOTKEY_ID, modifiers, key))
            {
                TalkityLog.Warn("Hotkey " + _settings.Hotkey + " is already in use; dictation hotkey inactive");
                _main.SetHint("The hotkey " + _settings.Hotkey + " is used by another program. Choose a different one in Settings.");
            }
        }

        private void SaveHudPosition()
        {
            _settings.HudX = _hud.Location.X;
            _settings.HudY = _hud.Location.Y;
            _settings.Save();
        }

        private void ClearHistory()
        {
            _history.Clear();
            RefreshHistoryView();
            TalkityLog.Info("Dictation history cleared");
        }

        private void RefreshHistoryView()
        {
            _main.ShowHistory(_history.Snapshot());
        }

        // ---- socket ----

        private void StartSocket()
        {
            _ws = new TalkityWsClient(
                _settings.Endpoint,
                _clientId,
                delegate(string text, string eventId) { DeliverRemoteText(text, eventId); },
                delegate(bool connected) { OnConnectionChanged(connected); });
            _ws.Start();
        }

        private void DeliverRemoteText(string text, string eventId)
        {
            if (_main.IsDisposed) return;
            _main.BeginInvoke(new Action(delegate
            {
                _lastTranscript = text;
                IntPtr target = GetForegroundWindow();
                bool ok = false;
                // A remote injection must not type into Talkity itself just because
                // the Talkity window happens to be in front.
                if (!IsOwnWindow(target)) ok = InsertText(target, text);
                else ClipboardSet(text);
                _hud.ApplyState(ok ? HudState.Inserted : HudState.Error, ok ? "Inserted" : "Copied to clipboard");
                _main.SetTranscript(text);
                if (!ok) _main.SetDictationState("Text from the extension is on the clipboard. Click the app you want and press Ctrl+V.", false);
                TalkityLog.Info("Remote inject " + (ok ? "delivered" : "kept on clipboard") +
                    ", eventId=" + eventId.Substring(0, Math.Min(8, eventId.Length)));
            }));
        }

        private void OnConnectionChanged(bool connected)
        {
            if (_main.IsDisposed) return;
            _main.BeginInvoke(new Action(delegate
            {
                _connected = connected;
                _hud.SetConnected(connected);
                _main.SetConnection(connected, connected ? "" : "reconnecting");
                if (_state == DictationState.Idle)
                    _tray.Text = connected ? "Talkity - connected" : "Talkity - reconnecting";
            }));
        }

        // ---- shutdown ----

        private void Shutdown()
        {
            TalkityLog.Info("Talkity exiting");
            if (_ws != null) { _ws.Stop(); _ws.Dispose(); }
            if (_whisperRecorder != null) { try { _whisperRecorder.Dispose(); } catch { } _whisperRecorder = null; }
            if (_whisperClient != null) { try { _whisperClient.Dispose(); } catch { } }
            UnregisterHotKey(_hotkeyWindow.Handle, HOTKEY_ID);
            if (_recognizer != null)
            {
                // Bump the session so any recognition callback still in flight is
                // discarded, then stop the engine before disposing it.
                lock (_stateLock) { _session++; _state = DictationState.Idle; }
                try { _recognizer.RecognizeAsyncCancel(); } catch { }
                _recognitionDrained.Set();
                try { _recognizer.Dispose(); } catch { }
            }
            if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
            if (_hud != null) _hud.Dispose();
            if (_main != null) _main.Dispose();
            ExitThread();
        }

        private static string ReadTitle(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static string StateName(DictationState s)
        {
            switch (s)
            {
                case DictationState.Idle: return "idle";
                case DictationState.Listening: return "listening";
                case DictationState.Paused: return "paused";
                case DictationState.Processing: return "processing";
                case DictationState.Inserting: return "inserting";
                default: return "unknown";
            }
        }
    }

    /// <summary>
    /// The decision rules behind dictation, separated from the Win32 and speech
    /// machinery so they can be tested without a microphone or a target window.
    /// TalkityController applies exactly these rules.
    /// </summary>
    internal static class DictationRules
    {
        /// <summary>
        /// Whether a final recognition result should be appended to the transcript.
        /// A result is kept only when it belongs to the session that is still active
        /// and that session is actually collecting, which rejects duplicates from an
        /// earlier session, results that arrive after cancellation, and blanks.
        /// </summary>
        public static bool AcceptResult(int resultSession, int currentSession, string state, string text)
        {
            if (resultSession != currentSession) return false;
            if (state != "listening" && state != "processing") return false;
            if (string.IsNullOrEmpty(text)) return false;
            for (int i = 0; i < text.Length; i++)
                if (!char.IsWhiteSpace(text[i])) return true;
            return false;
        }

        /// <summary>
        /// Whether a second dictation trigger should be ignored. Processing and
        /// inserting are not interruptible; allowing a trigger through either one is
        /// what produces a double insertion.
        /// </summary>
        public static bool TriggerIgnored(string state)
        {
            return state == "processing" || state == "inserting";
        }

        /// <summary>
        /// The outcome of an insertion attempt. The transcript is only reported as
        /// inserted when the target was valid, was not Talkity itself, took focus,
        /// and still held focus after the paste was given time to land. In every
        /// other case the transcript is kept for manual paste rather than discarded.
        /// </summary>
        public static string InsertionOutcome(bool targetValid, bool targetIsOwnWindow,
            bool clipboardPlaced, bool focusTaken, bool focusHeld)
        {
            if (!targetValid || targetIsOwnWindow) return "clipboard-only";
            if (!clipboardPlaced) return "clipboard-failed";
            if (!focusTaken || !focusHeld) return "clipboard-only";
            return "inserted";
        }

        /// <summary>
        /// The transcript to keep when enhancement fails. An enhancer that returns
        /// nothing, or reports that it did not enhance, must never replace the text
        /// the recognizer produced.
        ///
        /// Enhancement is also rejected when it changes the words the speaker said.
        /// The backend's "clean" pass was measured deleting fillers and paraphrasing
        /// ("Um, I think, you know" became "Let me think"), which silently changes
        /// dictation content. Only casing, punctuation, and spacing may differ.
        /// </summary>
        public static string TranscriptAfterEnhancement(string raw, string enhanced, bool enhancedOk)
        {
            if (!enhancedOk || string.IsNullOrEmpty(enhanced)) return raw ?? "";
            if (!WordsPreserved(raw, enhanced)) return raw ?? "";
            return enhanced;
        }

        /// <summary>
        /// True when two texts contain the same words in the same order. Punctuation,
        /// casing, and whitespace may differ; substitutions, insertions, and deletions
        /// are not allowed. Falls back to comparing the bare letter/digit sequence so
        /// that pure spacing changes ("3.30pm" vs "3:30 p.m.") still count as equal.
        /// </summary>
        public static bool WordsPreserved(string raw, string enhanced)
        {
            string a = ComparisonKey(raw);
            string b = ComparisonKey(enhanced);
            if (a.Length == 0) return b.Length == 0;
            if (a == b) return true;
            return LettersKey(raw) == LettersKey(enhanced);
        }

        /// <summary>
        /// Lowercased letter/digit tokens separated by single spaces. Apostrophes join
        /// ("let's" == "lets"); every other non-alphanumeric character is a separator.
        /// </summary>
        internal static string ComparisonKey(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            StringBuilder sb = new StringBuilder();
            bool pendingSpace = false;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsLetterOrDigit(c))
                {
                    if (pendingSpace && sb.Length > 0) sb.Append(' ');
                    pendingSpace = false;
                    sb.Append(char.ToLowerInvariant(c));
                }
                else if (c == '\'' || c == '\u2019')
                {
                    continue;
                }
                else
                {
                    pendingSpace = true;
                }
            }
            return sb.ToString();
        }

        /// <summary>Lowercased letters and digits only, with all separators removed.</summary>
        internal static string LettersKey(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsLetterOrDigit(c)) sb.Append(char.ToLowerInvariant(c));
            }
            return sb.ToString();
        }
    }

    /// <summary>Hidden window whose only job is to receive WM_HOTKEY.</summary>
    internal sealed class DictationMessageWindow : NativeWindow
    {
        private readonly Action _onHotkey;
        private const int WM_HOTKEY = 0x0312;

        public DictationMessageWindow(Action onHotkey)
        {
            _onHotkey = onHotkey;
            CreateHandle(new CreateParams());
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY) _onHotkey();
            base.WndProc(ref m);
        }
    }

    // ===========================================================
    // Protocol v1.0.0 WebSocket client (preserved from Phase 3)
    // ===========================================================

    /// <summary>
    /// WebSocket bridge to the Talkity server implementing Protocol v1.0.0.
    /// Runs entirely on background threads and reports back through callbacks.
    /// </summary>
    internal sealed class TalkityWsClient : IDisposable
    {
        private const string ProtocolVersion = "1.0.0";
        private const int HeartbeatTimeoutMs = 35000;
        private const int ClientPingIntervalMs = 20000;
        private const int InitialReconnectMs = 1000;
        private const int MaxReconnectMs = 30000;
        private const double ReconnectBackoff = 1.5;
        private const double JitterRange = 0.3;
        private const int MaxAttempts = 10;
        private const int MaxTextPayload = 5000;
        private const int MaxEventIdPayload = 64;
        private const int MaxProcessedEvents = 1000;

        private readonly string _wsUrl;
        private readonly string _clientId;
        private readonly Action<string, string> _onInjectText;
        private readonly Action<bool> _onConnectionChanged;

        private ClientWebSocket _ws;
        private CancellationTokenSource _lifetimeCts = new CancellationTokenSource();
        private CancellationTokenSource _reconnectCts = new CancellationTokenSource();

        private int _reconnectAttempts;
        private bool _disposed;
        private long _lastServerPingMs;
        private long _lastPongMs;

        private readonly HashSet<string> _processedEvents = new HashSet<string>();
        private readonly object _evtLock = new object();
        private readonly SemaphoreSlim _sendSemaphore = new SemaphoreSlim(1, 1);
        private static readonly Random _rng = new Random();

        public TalkityWsClient(string wsUrl, string clientId,
                               Action<string, string> onInjectText,
                               Action<bool> onConnectionChanged)
        {
            _wsUrl = wsUrl;
            _clientId = clientId;
            if (onInjectText == null) throw new ArgumentNullException("onInjectText");
            _onInjectText = onInjectText;
            if (onConnectionChanged == null) throw new ArgumentNullException("onConnectionChanged");
            _onConnectionChanged = onConnectionChanged;
        }

        public void Start()
        {
            Thread t = new Thread(ConnectionLoop) { IsBackground = true, Name = "TalkityWs" };
            t.Start();
        }

        public void Stop() { _lifetimeCts.Cancel(); }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _lifetimeCts.Cancel();
            if (_ws != null) _ws.Dispose();
            _sendSemaphore.Dispose();
        }

        private void ConnectionLoop()
        {
            while (!_lifetimeCts.IsCancellationRequested)
            {
                if (_reconnectCts != null) _reconnectCts.Cancel();
                _reconnectCts = new CancellationTokenSource();

                using (CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(
                           _lifetimeCts.Token, _reconnectCts.Token))
                {
                    try
                    {
                        if (_ws != null) _ws.Dispose();
                        _ws = new ClientWebSocket();
                        _ws.ConnectAsync(new Uri(_wsUrl), linked.Token).GetAwaiter().GetResult();

                        TalkityLog.Info("WebSocket connected");
                        _reconnectAttempts = 0;
                        _lastPongMs = NowMs();
                        _onConnectionChanged(true);

                        SendJson(new
                        {
                            type = "register_desktop",
                            clientId = _clientId,
                            protocolVersion = ProtocolVersion,
                            timestamp = NowMs()
                        });

                        Thread pingThread = new Thread(delegate() { ClientPingLoop(linked.Token); })
                            { IsBackground = true, Name = "TalkityWsPing" };
                        pingThread.Start();

                        ReceiveLoop(linked.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        if (_lifetimeCts.IsCancellationRequested) break;
                    }
                    catch (WebSocketException ex)
                    {
                        // WebSocketErrorCode is Success when the TLS handshake fails,
                        // which hides the real reason. The inner exception names it
                        // (typically a WebException with SecureChannelFailure).
                        Exception inner = ex.InnerException;
                        TalkityLog.Warn("WebSocket error: " + ex.WebSocketErrorCode +
                            (inner == null ? "" : " (" + inner.GetType().Name + ": " + inner.Message + ")"));
                    }
                    catch (Exception ex)
                    {
                        TalkityLog.Warn("WebSocket connection error: " + ex.GetType().Name);
                    }
                    finally
                    {
                        _onConnectionChanged(false);
                    }
                }

                if (_lifetimeCts.IsCancellationRequested) break;
                if (!ScheduleReconnect()) break;
            }
            TalkityLog.Info("WebSocket connection loop exited");
        }

        private void ReceiveLoop(CancellationToken ct)
        {
            byte[] buffer = new byte[8192];
            StringBuilder fragment = new StringBuilder();

            while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
            {
                try
                {
                    WebSocketReceiveResult result = _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct)
                                                         .GetAwaiter().GetResult();

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        TalkityLog.Info("Server closed the connection");
                        _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "ok", CancellationToken.None)
                           .GetAwaiter().GetResult();
                        return;
                    }

                    fragment.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    if (result.EndOfMessage)
                    {
                        string raw = fragment.ToString();
                        fragment.Clear();
                        ProcessMessage(raw);
                    }
                }
                catch (OperationCanceledException) { return; }
                catch (WebSocketException) { return; }
            }
        }

        private void ProcessMessage(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return;

            Dictionary<string, string> msg;
            try { msg = TalkityJson.ParseFlat(raw); }
            catch
            {
                TalkityLog.Warn("Malformed WebSocket message");
                SendError("invalid_json", "Message is not valid JSON");
                return;
            }

            string type;
            if (!msg.TryGetValue("type", out type)) return;

            switch (type)
            {
                case "connected":
                    TalkityLog.Info("Server acknowledged connection");
                    break;

                case "heartbeat":
                    _lastServerPingMs = NowMs();
                    _lastPongMs = NowMs();
                    SendJson(new { type = "heartbeat_ack", clientId = _clientId, timestamp = NowMs() });
                    break;

                case "heartbeat_ack":
                    _lastPongMs = NowMs();
                    break;

                case "inject_text":
                    HandleInjectText(msg);
                    break;

                case "desktop_status":
                    TalkityLog.Info("Desktop status: connected=" + GetField(msg, "connected"));
                    break;

                case "error":
                    TalkityLog.Warn("Server error [" + GetField(msg, "code") + "]");
                    break;

                case "ack":
                    TalkityLog.Info("Ack received, success=" + GetField(msg, "success"));
                    break;

                default:
                    TalkityLog.Info("Unknown message type ignored");
                    break;
            }
        }

        private void HandleInjectText(Dictionary<string, string> msg)
        {
            string text = GetField(msg, "text");
            string eventId = GetField(msg, "eventId");

            if (string.IsNullOrEmpty(text))
            {
                string eid = string.IsNullOrEmpty(eventId) ? Guid.NewGuid().ToString("N").Substring(0, 8) : eventId;
                SendJson(new { type = "ack", eventId = eid, success = false, reason = "empty_text" });
                return;
            }

            if (text.Length > MaxTextPayload) text = text.Substring(0, MaxTextPayload);
            if (string.IsNullOrEmpty(eventId)) eventId = Guid.NewGuid().ToString("N");
            if (eventId.Length > MaxEventIdPayload) eventId = eventId.Substring(0, MaxEventIdPayload);

            lock (_evtLock)
            {
                if (_processedEvents.Contains(eventId))
                {
                    TalkityLog.Info("Duplicate event suppressed");
                    return;
                }
                _processedEvents.Add(eventId);
                if (_processedEvents.Count > MaxProcessedEvents) _processedEvents.Clear();
            }

            _onInjectText(text, eventId);
        }

        private void ClientPingLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
            {
                try { Thread.Sleep(ClientPingIntervalMs); }
                catch (ThreadInterruptedException) { return; }
                if (ct.IsCancellationRequested) return;

                if (_lastServerPingMs > 0 && NowMs() - _lastServerPingMs > HeartbeatTimeoutMs)
                {
                    TalkityLog.Warn("Server silent past heartbeat timeout; reconnecting");
                    if (_reconnectCts != null) _reconnectCts.Cancel();
                    return;
                }

                SendJson(new { type = "heartbeat", clientId = _clientId, timestamp = NowMs() });
            }
        }

        private bool ScheduleReconnect()
        {
            _reconnectAttempts++;
            if (_reconnectAttempts > MaxAttempts)
            {
                TalkityLog.Warn("Giving up after " + MaxAttempts + " reconnect attempts");
                return false;
            }

            double delay = Math.Min(InitialReconnectMs * Math.Pow(ReconnectBackoff, _reconnectAttempts - 1), MaxReconnectMs);
            double jitter = _rng.NextDouble() * JitterRange * delay;
            int totalMs = (int)(delay + jitter);

            TalkityLog.Info("Reconnecting in " + totalMs + "ms (attempt " + _reconnectAttempts + "/" + MaxAttempts + ")");
            try { Thread.Sleep(totalMs); }
            catch (ThreadInterruptedException) { return false; }
            return !_lifetimeCts.IsCancellationRequested;
        }

        private void SendJson(object obj)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;
            byte[] bytes = Encoding.UTF8.GetBytes(TalkityJson.SerializeFlat(obj));

            _sendSemaphore.Wait();
            try
            {
                _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None)
                   .GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("WebSocket send failed: " + ex.GetType().Name);
            }
            finally
            {
                _sendSemaphore.Release();
            }
        }

        private void SendError(string code, string message)
        {
            SendJson(new { type = "error", code = code, message = message, clientId = _clientId });
        }

        private static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static string GetField(Dictionary<string, string> d, string key)
        {
            string v;
            return d.TryGetValue(key, out v) ? v : "";
        }
    }
}
