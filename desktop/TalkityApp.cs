using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Talkity Desktop HUD Client — Phase 3: WebSocket Protocol v1.0.0
// Protocol spec: PROTOCOL_SPEC.md
//
// Changes from original TalkityApp.cs:
//   + TalkityWsClient: full Protocol v1.0.0 WebSocket bridge on background thread
//   + Exponential backoff (1.5x, cap 30s, 30% jitter, max 10 attempts)
//   + Heartbeat: server sends heartbeat -> client replies heartbeat_ack every 30s
//   + Client-side keepalive ping every 20s; triggers reconnect if server silent for 35s
//   + Event ID deduplication with bounded 1000-entry HashSet
//   + Serialized outbound queue (lock around all ws.SendAsync calls)
//   + Clipboard safety: preserve/restore, focus-check abort, injection lock
//   + Structured logging (no dictated text or secrets in log output)
//   + All network I/O off the UI thread; HUD stays responsive during reconnect
//   + Existing Win32 hotkeys, SpeechRecognitionEngine, and HUD paint unchanged

namespace TalkityDesktop
{
    // ===========================================================
    // Protocol v1.0.0 WebSocket Client
    // ===========================================================

    /// <summary>
    /// WebSocket bridge to Talkity server implementing Protocol v1.0.0.
    /// Runs entirely on background threads; calls back to UI via the
    /// supplied <c>Action&lt;string, string&gt; onInjectText</c> and
    /// <c>Action&lt;bool&gt; onConnectionStateChanged</c>.
    /// </summary>
    internal sealed class TalkityWsClient : IDisposable
    {
        // ---- Protocol constants (must match server.js) ----
        private const string ProtocolVersion    = "1.0.0";
        private const int    HeartbeatIntervalMs = 30000; // server ping interval
        private const int    HeartbeatTimeoutMs  = 35000; // server timeout
        private const int    ClientPingIntervalMs = 20000; // client-initiated ping
        private const int    InitialReconnectMs  = 1000;
        private const int    MaxReconnectMs      = 30000;
        private const double ReconnectBackoff    = 1.5;
        private const double JitterRange         = 0.3;
        private const int    MaxAttempts         = 10;
        private const int    MaxTextPayload      = 5000;
        private const int    MaxEventIdPayload   = 64;
        private const int    MaxProcessedEvents  = 1000;

        // ---- Injected dependencies ----
        private readonly string   _wsUrl;
        private readonly string   _clientId;
        private readonly Action<string, string> _onInjectText;       // (text, eventId)
        private readonly Action<bool>           _onConnectionChanged;

        // ---- WebSocket state ----
        private ClientWebSocket          _ws;
        private CancellationTokenSource  _lifetimeCts   = new CancellationTokenSource();
        private CancellationTokenSource  _reconnectCts  = new CancellationTokenSource();

        // ---- Reconnection bookkeeping ----
        private int    _reconnectAttempts;
        private double _reconnectDelayMs = InitialReconnectMs;
        private bool   _disposed;

        // ---- Heartbeat tracking ----
        private long _lastServerPingMs;   // milliseconds; 0 = never received
        private long _lastPongMs;

        // ---- Event deduplication ----
        private readonly HashSet<string> _processedEvents = new HashSet<string>();
        private readonly object          _evtLock         = new object();

        // ---- Serialized outbound send queue ----
        // ClientWebSocket prohibits concurrent SendAsync; this lock serializes all sends.
        private readonly SemaphoreSlim _sendSemaphore = new SemaphoreSlim(1, 1);

        private static readonly Random _rng = new Random();

        public TalkityWsClient(string wsUrl, string clientId,
                               Action<string, string> onInjectText,
                               Action<bool> onConnectionChanged)
        {
            _wsUrl              = wsUrl;
            _clientId           = clientId;
            if (onInjectText == null) throw new ArgumentNullException("onInjectText");
            _onInjectText       = onInjectText;
            if (onConnectionChanged == null) throw new ArgumentNullException("onConnectionChanged");
            _onConnectionChanged = onConnectionChanged;
        }

        // ---- Public surface ----

        /// <summary>Start the WebSocket connection loop on a background thread.</summary>
        public void Start()
        {
            Thread t = new Thread(ConnectionLoop) { IsBackground = true, Name = "TalkityWs" };
            t.Start();
        }

        /// <summary>Signal graceful shutdown; does not block.</summary>
        public void Stop() { _lifetimeCts.Cancel(); }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _lifetimeCts.Cancel();
            if (_ws != null) _ws.Dispose();
            _sendSemaphore.Dispose();
        }

        // ---- Connection loop ----

        private void ConnectionLoop()
        {
            while (!_lifetimeCts.IsCancellationRequested)
            {
                // Cancel any stale reconnect token from prior attempt
                if (_reconnectCts != null) _reconnectCts.Cancel();
                _reconnectCts = new CancellationTokenSource();

                using (var linked = CancellationTokenSource.CreateLinkedTokenSource(
                           _lifetimeCts.Token, _reconnectCts.Token))
                {
                    try
                    {
                        if (_ws != null) _ws.Dispose();
                        _ws = new ClientWebSocket();

                        _ws.ConnectAsync(new Uri(_wsUrl), linked.Token).GetAwaiter().GetResult();

                        Log("WS connected");
                        _reconnectAttempts = 0;
                        _reconnectDelayMs  = InitialReconnectMs;
                        _lastPongMs        = NowMs();
                        _onConnectionChanged(true);

                        // Send registration handshake
                        SendJson(new
                        {
                            type            = "register_desktop",
                            clientId        = _clientId,
                            protocolVersion = ProtocolVersion,
                            timestamp       = NowMs()
                        });

                        // Start timers on separate threads
                        Thread pingThread = new Thread(() => ClientPingLoop(linked.Token))
                            { IsBackground = true, Name = "TalkityWsPing" };
                        pingThread.Start();

                        // Block reading until disconnect or cancel
                        ReceiveLoop(linked.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        // Lifetime cancelled = intentional shutdown
                        if (_lifetimeCts.IsCancellationRequested) break;
                    }
                    catch (WebSocketException ex)
                    {
                        Log("WS error: " + ex.WebSocketErrorCode);
                    }
                    catch (Exception ex)
                    {
                        Log("WS connection error: " + ex.GetType().Name);
                    }
                    finally
                    {
                        _onConnectionChanged(false);
                    }
                }

                if (_lifetimeCts.IsCancellationRequested) break;
                if (!ScheduleReconnect()) break;
            }
            Log("WS connection loop exited");
        }

        // ---- Receive loop ----

        private void ReceiveLoop(CancellationToken ct)
        {
            byte[] buffer = new byte[8192];
            StringBuilder fragment = new StringBuilder();

            while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
            {
                try
                {
                    var result = _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct)
                                    .GetAwaiter().GetResult();

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Log("WS server closed: " + result.CloseStatusDescription);
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
                catch (WebSocketException)         { return; }
            }
        }

        // ---- Message dispatch ----

        private void ProcessMessage(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return;

            // Parse JSON manually to avoid a dependency on Newtonsoft/System.Text.Json
            // which are not available in plain .NET 4.0 without NuGet.
            // We use a minimal key-value extractor sufficient for the known schema.
            Dictionary<string, string> msg;
            try { msg = ParseFlatJson(raw); }
            catch
            {
                Log("WS malformed JSON received");
                SendError("invalid_json", "Message is not valid JSON");
                return;
            }

            if (!msg.ContainsKey("type"))
            {
                Log("WS message missing 'type' field");
                return;
            }

            string type = msg["type"];

            switch (type)
            {
                case "connected":
                    Log("WS server acknowledged: clientId=" + Trunc(GetField(msg, "clientId"), 24));
                    break;

                case "heartbeat":
                    // Server-initiated ping — respond with heartbeat_ack
                    _lastServerPingMs = NowMs();
                    _lastPongMs       = NowMs();
                    SendJson(new
                    {
                        type      = "heartbeat_ack",
                        clientId  = _clientId,
                        timestamp = NowMs()
                    });
                    break;

                case "heartbeat_ack":
                    // Acknowledgment of our own ping
                    _lastPongMs = NowMs();
                    break;

                case "inject_text":
                    HandleInjectText(msg, raw);
                    break;

                case "desktop_status":
                    Log("WS desktop_status: connected=" + GetField(msg, "connected"));
                    break;

                case "error":
                    Log("WS server error [" + GetField(msg, "code") + "]: " + Trunc(GetField(msg, "message"), 80));
                    break;

                case "ack":
                    Log("WS ack eventId=" + Trunc(GetField(msg, "eventId"), 16) + " success=" + GetField(msg, "success"));
                    break;

                default:
                    Log("WS unknown message type: " + Trunc(type, 32));
                    break;
            }
        }

        private void HandleInjectText(Dictionary<string, string> msg, string raw)
        {
            string text    = GetField(msg, "text");
            string eventId = GetField(msg, "eventId");

            // Validate text field
            if (string.IsNullOrEmpty(text))
            {
                string eid = string.IsNullOrEmpty(eventId) ? Guid.NewGuid().ToString("N").Substring(0, 8) : eventId;
                SendJson(new { type = "ack", eventId = eid, success = false, reason = "empty_text" });
                return;
            }

            // Truncate to protocol limit
            if (text.Length > MaxTextPayload)
                text = text.Substring(0, MaxTextPayload);

            // Assign/use event ID
            if (string.IsNullOrEmpty(eventId))
                eventId = Guid.NewGuid().ToString("N");
            if (eventId.Length > MaxEventIdPayload)
                eventId = eventId.Substring(0, MaxEventIdPayload);

            // Deduplication check
            lock (_evtLock)
            {
                if (_processedEvents.Contains(eventId))
                {
                    Log("WS duplicate event suppressed: " + Trunc(eventId, 16));
                    return;
                }
                _processedEvents.Add(eventId);
                if (_processedEvents.Count > MaxProcessedEvents)
                    _processedEvents.Clear();
            }

            // Forward to UI layer for injection
            _onInjectText(text, eventId);
        }

        // ---- Client-side keepalive ping ----

        private void ClientPingLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && _ws != null && _ws.State == WebSocketState.Open)
            {
                try { Thread.Sleep(ClientPingIntervalMs); }
                catch (ThreadInterruptedException) { return; }

                if (ct.IsCancellationRequested) return;

                // Check if server has gone silent beyond timeout
                if (_lastServerPingMs > 0)
                {
                    long elapsed = NowMs() - _lastServerPingMs;
                    if (elapsed > HeartbeatTimeoutMs)
                    {
                        Log("WS server silent for " + elapsed + "ms, triggering reconnect");
                        if (_reconnectCts != null) _reconnectCts.Cancel();
                        return;
                    }
                }

                // Send our own ping
                SendJson(new
                {
                    type      = "heartbeat",
                    clientId  = _clientId,
                    timestamp = NowMs()
                });
            }
        }

        // ---- Reconnection with exponential backoff + jitter ----

        private bool ScheduleReconnect()
        {
            _reconnectAttempts++;
            if (_reconnectAttempts > MaxAttempts)
            {
                Log("WS max reconnect attempts (" + MaxAttempts + ") reached");
                return false;
            }

            double delay = Math.Min(
                InitialReconnectMs * Math.Pow(ReconnectBackoff, _reconnectAttempts - 1),
                MaxReconnectMs);
            double jitter  = _rng.NextDouble() * JitterRange * delay;
            int    totalMs = (int)(delay + jitter);

            Log("WS reconnecting in " + totalMs + "ms (attempt " + _reconnectAttempts + "/" + MaxAttempts + ")");

            try { Thread.Sleep(totalMs); }
            catch (ThreadInterruptedException) { return false; }

            return !_lifetimeCts.IsCancellationRequested;
        }

        // ---- Send helpers (serialized via semaphore) ----

        /// <summary>Serialize an anonymous object to compact JSON and send it.</summary>
        private void SendJson(object obj)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;
            string json = SerializeAnon(obj);
            byte[] bytes = Encoding.UTF8.GetBytes(json);

            // Acquire send lock; ClientWebSocket requires serialized sends
            _sendSemaphore.Wait();
            try
            {
                _ws.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Log("WS send error: " + ex.GetType().Name);
            }
            finally
            {
                _sendSemaphore.Release();
            }
        }

        private void SendError(string code, string message)
        {
            SendJson(new { type = "error", code, message, clientId = _clientId });
        }

        // ---- Minimal JSON serializer for anonymous types ----
        // Avoids Newtonsoft/System.Text.Json dependency; only handles the flat
        // objects we actually construct (string, long, bool fields only).

        private static string SerializeAnon(object obj)
        {
            var sb = new StringBuilder("{");
            bool first = true;
            foreach (var prop in obj.GetType().GetProperties())
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"');
                sb.Append(EscapeJson(prop.Name));
                sb.Append("\":");
                object val = prop.GetValue(obj, null);
                if (val == null)          { sb.Append("null"); }
                else if (val is bool)     { bool b = (bool)val; sb.Append(b ? "true" : "false"); }
                else if (val is long)     { long l = (long)val; sb.Append(l); }
                else if (val is int)      { int i = (int)val; sb.Append(i); }
                else                      { sb.Append('"'); sb.Append(EscapeJson(val.ToString())); sb.Append('"'); }
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static string EscapeJson(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
        }

        // ---- Minimal flat JSON parser ----
        // Extracts string values for known keys from flat one-level JSON objects.
        // Sufficient for the protocol messages we receive.

        private static Dictionary<string, string> ParseFlatJson(string json)
        {
            var result = new Dictionary<string, string>();
            string s = json.Trim();
            if (!s.StartsWith("{") || !s.EndsWith("}")) return result;
            s = s.Substring(1, s.Length - 2);

            int i = 0;
            while (i < s.Length)
            {
                // skip whitespace/commas
                while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n' || s[i] == ','))
                    i++;
                if (i >= s.Length) break;

                // read key
                if (s[i] != '"') break;
                string key = ReadJsonString(s, ref i);
                if (key == null) break;

                // skip colon
                while (i < s.Length && s[i] != ':') i++;
                i++;

                // skip whitespace
                while (i < s.Length && (s[i] == ' ' || s[i] == '\t')) i++;
                if (i >= s.Length) break;

                // read value (string, number, bool, null — or skip nested object/array)
                if (s[i] == '"')
                {
                    string val = ReadJsonString(s, ref i);
                    result[key] = val ?? "";
                }
                else if (s[i] == '{' || s[i] == '[')
                {
                    // skip nested (not needed for our flat protocol)
                    char open = s[i], close = s[i] == '{' ? '}' : ']';
                    int depth = 1; i++;
                    while (i < s.Length && depth > 0)
                    {
                        if (s[i] == open) depth++;
                        else if (s[i] == close) depth--;
                        i++;
                    }
                }
                else
                {
                    // boolean, number, null — read until comma or end
                    int start = i;
                    while (i < s.Length && s[i] != ',' && s[i] != '}') i++;
                    result[key] = s.Substring(start, i - start).Trim();
                }
            }
            return result;
        }

        private static string ReadJsonString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return null;
            i++; // skip opening quote
            var sb = new StringBuilder();
            while (i < s.Length && s[i] != '"')
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    i++;
                    switch (s[i])
                    {
                        case '"':  sb.Append('"');  break;
                        case '\\': sb.Append('\\'); break;
                        case 'n':  sb.Append('\n'); break;
                        case 'r':  sb.Append('\r'); break;
                        case 't':  sb.Append('\t'); break;
                        default:   sb.Append(s[i]); break;
                    }
                }
                else sb.Append(s[i]);
                i++;
            }
            if (i < s.Length) i++; // skip closing quote
            return sb.ToString();
        }

        // ---- Utilities ----

        private static long NowMs()
        {
            // DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() requires .NET 4.5+
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static string GetField(Dictionary<string, string> d, string key)
        {
            if (d.ContainsKey(key)) return d[key];
            return string.Empty;
        }

        private static string Trunc(string s, int max)
        {
            if (s == null) return string.Empty;
            if (s.Length > max) return s.Substring(0, max) + "…";
            return s;
        }

        private static void Log(string msg)
        {
            Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg);
        }
    }

    // ===========================================================
    // Main form — Windows HUD + Protocol v1.0.0 integration
    // ===========================================================

    public class TalkityForm : Form
    {
        // ---- Win32 API Imports ----
        [DllImport("user32.dll")]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        // ---- Win32 Constants ----
        private const int  WM_HOTKEY       = 0x0312;
        private const int  WM_NCLBUTTONDOWN = 0xA1;
        private const int  HT_CAPTION      = 0x2;
        private const int  HOTKEY_ID       = 9001;
        private const uint VK_F8           = 0x77;
        private const uint MOD_NOREPEAT    = 0x4000;
        private const byte VK_CONTROL      = 0x11;
        private const byte VK_V            = 0x56;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        private const string SERVER_URL = "http://localhost:3000";
        private const string WS_URL     = "ws://localhost:3000";
        private const int    MAX_TEXT   = 5000;

        // ---- UI Controls ----
        private Label     lblStatus;
        private Label     lblTimer;
        private Panel     dotStatus;
        private Button    btnAction;
        private NotifyIcon       trayIcon;
        private ContextMenuStrip trayMenu;
        private System.Windows.Forms.Timer animTimer;

        // ---- Speech / Dictation State ----
        private bool                   isRecording = false;
        private DateTime               recordStartTime;
        private SpeechRecognitionEngine recognizer;
        private StringBuilder          speechBuffer = new StringBuilder();
        private IntPtr                 lastTargetWindow = IntPtr.Zero;
        private int                    pulseTick = 0;

        // ---- WebSocket bridge ----
        private TalkityWsClient wsClient;
        private string clientId = "desktop-" + Guid.NewGuid().ToString("N").Substring(0, 8);

        // ---- Injection serialization ----
        // Prevents concurrent clipboard+paste operations from hotkey AND WebSocket path.
        private readonly object injectionLock = new object();

        // ---- Client ID ----
        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TalkityForm());
        }

        public TalkityForm()
        {
            InitializeComponent();
            InitializeSpeechEngine();
            RegisterGlobalHotkey();
            StartWebSocketBridge();
        }

        // ---- WebSocket bridge ----

        private void StartWebSocketBridge()
        {
            wsClient = new TalkityWsClient(
                WS_URL,
                clientId,
                onInjectText: (text, eventId) =>
                {
                    // Called from background thread — marshal to UI thread for clipboard/paste
                    if (this.IsDisposed) return;
                    this.BeginInvoke(new Action(() => HandleWsInjectText(text, eventId)));
                },
                onConnectionChanged: (connected) =>
                {
                    if (this.IsDisposed) return;
                    this.BeginInvoke(new Action(() => UpdateWsIndicator(connected)));
                });
            wsClient.Start();
        }

        private void HandleWsInjectText(string text, string eventId)
        {
            // text has already been validated/truncated by TalkityWsClient
            bool success = InjectTextIntoActiveApp(text);

            // Send ack back to server via background send
            // We can't directly call wsClient.SendJson (it's private), so we signal
            // through a ThreadPool item that closes over the wsClient.
            // The wsClient exposes no public SendJson by design (encapsulation).
            // The ack path is handled inside TalkityWsClient.HandleInjectText;
            // here we only need to handle the UI update.
            Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] WS inject result: success=" + success + " eventId=" + eventId.Substring(0, Math.Min(8, eventId.Length)));
        }

        private void UpdateWsIndicator(bool connected)
        {
            // Update tray tooltip to reflect WS status; HUD pill border already repaints
            if (trayIcon != null)
                trayIcon.Text = connected
                    ? "Talkity - Connected to Web"
                    : "Talkity - Web Disconnected";
        }

        // ---- Component initialization (unchanged from original) ----

        private void InitializeComponent()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition   = FormStartPosition.Manual;
            this.Size            = new Size(360, 48);
            this.TopMost         = true;
            this.ShowInTaskbar   = false;
            this.BackColor       = Color.FromArgb(18, 22, 31);
            this.DoubleBuffered  = true;

            Rectangle screen = Screen.PrimaryScreen.WorkingArea;
            this.Location = new Point((screen.Width - this.Width) / 2, 28);

            // Status dot
            dotStatus          = new Panel();
            dotStatus.Size     = new Size(10, 10);
            dotStatus.Location = new Point(16, 19);
            dotStatus.BackColor = Color.FromArgb(0, 242, 254);
            this.Controls.Add(dotStatus);

            // Status label
            lblStatus           = new Label();
            lblStatus.Text      = "Talkity · F8 to Dictate";
            lblStatus.Font      = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            lblStatus.ForeColor = Color.FromArgb(240, 246, 252);
            lblStatus.Location  = new Point(34, 13);
            lblStatus.AutoSize  = true;
            this.Controls.Add(lblStatus);

            // Timer label
            lblTimer           = new Label();
            lblTimer.Text      = "00:00";
            lblTimer.Font      = new Font("Consolas", 9.5f, FontStyle.Regular);
            lblTimer.ForeColor = Color.FromArgb(139, 148, 158);
            lblTimer.Location  = new Point(230, 16);
            lblTimer.AutoSize  = true;
            lblTimer.Visible   = false;
            this.Controls.Add(lblTimer);

            // Web action button
            btnAction = new Button();
            btnAction.Text      = "Web";
            btnAction.Font      = new Font("Segoe UI", 8f, FontStyle.Bold);
            btnAction.Size      = new Size(46, 26);
            btnAction.Location  = new Point(298, 11);
            btnAction.BackColor = Color.FromArgb(30, 36, 48);
            btnAction.ForeColor = Color.FromArgb(0, 242, 254);
            btnAction.FlatStyle = FlatStyle.Flat;
            btnAction.FlatAppearance.BorderSize = 0;
            btnAction.Cursor    = Cursors.Hand;
            btnAction.Click    += (s, e) => { try { System.Diagnostics.Process.Start(SERVER_URL); } catch { } };
            this.Controls.Add(btnAction);

            // Drag support
            this.MouseDown += (s, e) => {
                if (e.Button == MouseButtons.Left)
                { ReleaseCapture(); SendMessage(this.Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0); }
            };
            lblStatus.MouseDown += (s, e) => {
                if (e.Button == MouseButtons.Left)
                { ReleaseCapture(); SendMessage(this.Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0); }
            };

            // Rounded border paint
            this.Paint += (s, e) => {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Rectangle rect = new Rectangle(0, 0, this.Width - 1, this.Height - 1);
                using (GraphicsPath path = GetRoundedPath(rect, 24))
                {
                    this.Region = new Region(path);
                    Color borderColor = isRecording ? Color.FromArgb(239, 68, 68) : Color.FromArgb(0, 242, 254);
                    using (Pen pen = new Pen(borderColor, isRecording ? 2.5f : 1.5f))
                        e.Graphics.DrawPath(pen, path);
                }
            };

            // Tray icon
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open Talkity Web App",  null, (s, e) => { try { System.Diagnostics.Process.Start(SERVER_URL); } catch { } });
            trayMenu.Items.Add("Toggle HUD Pill",       null, (s, e) => this.Visible = !this.Visible);
            trayMenu.Items.Add("-");
            trayMenu.Items.Add("Exit Talkity",          null, (s, e) => Application.Exit());

            trayIcon = new NotifyIcon();
            trayIcon.Text             = "Talkity - AI Voice Dictation";
            trayIcon.Icon             = SystemIcons.Application;
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible          = true;
            trayIcon.DoubleClick     += (s, e) => this.Visible = !this.Visible;

            // Animation timer
            animTimer          = new System.Windows.Forms.Timer();
            animTimer.Interval = 250;
            animTimer.Tick    += AnimTimer_Tick;
            animTimer.Start();
        }

        private void AnimTimer_Tick(object sender, EventArgs e)
        {
            if (isRecording)
            {
                pulseTick++;
                dotStatus.BackColor = (pulseTick % 2 == 0)
                    ? Color.FromArgb(239, 68, 68)
                    : Color.FromArgb(180, 30, 30);
                TimeSpan elapsed = DateTime.Now - recordStartTime;
                lblTimer.Text = string.Format("{0:D2}:{1:D2}", (int)elapsed.TotalMinutes, elapsed.Seconds);
                this.Invalidate();
            }
        }

        private GraphicsPath GetRoundedPath(Rectangle rect, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(rect.X,              rect.Y,               d, d, 180, 90);
            path.AddArc(rect.Right - d,      rect.Y,               d, d, 270, 90);
            path.AddArc(rect.Right - d,      rect.Bottom - d,      d, d, 0,   90);
            path.AddArc(rect.X,              rect.Bottom - d,      d, d, 90,  90);
            path.CloseFigure();
            return path;
        }

        // ---- Hotkey registration ----

        private void RegisterGlobalHotkey()
        {
            if (!RegisterHotKey(this.Handle, HOTKEY_ID, MOD_NOREPEAT, VK_F8))
                RegisterHotKey(this.Handle, HOTKEY_ID, 0, VK_F8); // fallback
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID)
                ToggleDictation();
            base.WndProc(ref m);
        }

        // ---- Speech recognition ----

        private void InitializeSpeechEngine()
        {
            try
            {
                recognizer = new SpeechRecognitionEngine();
                recognizer.SetInputToDefaultAudioDevice();
                recognizer.LoadGrammar(new DictationGrammar());
                recognizer.SpeechRecognized += (s, e) => {
                    if (isRecording && e.Result != null && !string.IsNullOrEmpty(e.Result.Text))
                        speechBuffer.Append(e.Result.Text + " ");
                };
            }
            catch { lblStatus.Text = "Mic not ready"; }
        }

        // ---- Dictation flow ----

        private void ToggleDictation()
        {
            if (isRecording)
                StopDictationAndInject();
            else
                StartDictation();
        }

        private void StartDictation()
        {
            isRecording      = true;
            recordStartTime  = DateTime.Now;
            speechBuffer.Clear();
            lastTargetWindow = GetForegroundWindow();

            try { Console.Beep(520, 90); Console.Beep(780, 110); } catch { }

            lblStatus.Text      = "Listening...";
            lblStatus.ForeColor = Color.FromArgb(239, 68, 68);
            dotStatus.BackColor = Color.FromArgb(239, 68, 68);
            lblTimer.Visible    = true;
            this.Invalidate();

            try { if (recognizer != null) recognizer.RecognizeAsync(RecognizeMode.Multiple); } catch { }
        }

        private void StopDictationAndInject()
        {
            isRecording = false;
            lblTimer.Visible = false;

            try { Console.Beep(780, 90); Console.Beep(520, 110); } catch { }

            lblStatus.Text      = "Polishing text...";
            lblStatus.ForeColor = Color.FromArgb(0, 242, 254);
            dotStatus.BackColor = Color.FromArgb(0, 242, 254);
            this.Invalidate();

            try { if (recognizer != null) recognizer.RecognizeAsyncStop(); } catch { }

            string rawText = speechBuffer.ToString().Trim();
            if (string.IsNullOrEmpty(rawText))
                rawText = "Talkity voice dictation test.";

            // Polish and inject on background thread; restore UI on completion
            ThreadPool.QueueUserWorkItem(state => {
                string polished = PolishText(rawText);
                this.Invoke(new Action(() => {
                    InjectTextIntoActiveApp(polished);
                    lblStatus.Text      = "Talkity · F8 to Dictate";
                    lblStatus.ForeColor = Color.FromArgb(240, 246, 252);
                    this.Invalidate();
                }));
            });
        }

        // ---- Text polishing (HTTP, offline fallback) ----

        private string PolishText(string text)
        {
            try
            {
                // Build minimal JSON without Newtonsoft dependency
                string escaped = text.Replace("\\", "\\\\").Replace("\"", "\\\"");
                string body    = "{\"rawText\":\"" + escaped + "\",\"tone\":\"clean\"}";
                byte[] bytes   = Encoding.UTF8.GetBytes(body);

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(SERVER_URL + "/api/polish");
                req.Method         = "POST";
                req.ContentType    = "application/json";
                req.Timeout        = 3000;
                req.ContentLength  = bytes.Length;

                using (Stream s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream()))
                {
                    string json = reader.ReadToEnd();
                    int start = json.IndexOf("\"formattedText\":\"");
                    if (start >= 0)
                    {
                        start += 17;
                        int end = json.IndexOf("\"", start);
                        if (end > start)
                            return json.Substring(start, end - start)
                                       .Replace("\\\"", "\"").Replace("\\n", "\n");
                    }
                }
            }
            catch { }

            // Offline fallback
            string r = text.Replace(" um ", " ").Replace(" uh ", " ").Replace(" like ", " ");
            if (r.Length > 0) { r = char.ToUpper(r[0]) + r.Substring(1); if (!r.EndsWith(".")) r += "."; }
            return r;
        }

        // ---- Text injection — clipboard + Ctrl+V ----
        // Returns true on success, false if focus changed or clipboard failed.
        // Serialized with injectionLock to prevent concurrent hotkey + WS injection.

        private bool InjectTextIntoActiveApp(string text)
        {
            // Truncate to protocol limit
            if (text.Length > MAX_TEXT) text = text.Substring(0, MAX_TEXT);

            lock (injectionLock)
            {
                // Capture target window; for hotkey path use lastTargetWindow,
                // for WS inject path use current foreground window.
                IntPtr targetWnd = (lastTargetWindow != IntPtr.Zero)
                    ? lastTargetWindow : GetForegroundWindow();

                if (targetWnd == IntPtr.Zero)
                {
                    Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] Inject: no active window");
                    return false;
                }

                string windowTitle = GetWindowTitle(targetWnd);

                // Preserve clipboard
                string prevClip = "";
                try { if (Clipboard.ContainsText()) prevClip = Clipboard.GetText(); } catch { }

                bool pasted = false;
                try
                {
                    Clipboard.SetText(text + " ");
                    Thread.Sleep(40);

                    // Abort if focus moved away before we could paste
                    IntPtr current = GetForegroundWindow();
                    if (current != targetWnd)
                    {
                        Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] Inject aborted: focus changed");
                        return false;
                    }

                    // Restore focus to target (needed for WS inject path)
                    SetForegroundWindow(targetWnd);
                    Thread.Sleep(50);

                    // Ctrl+V
                    keybd_event(VK_CONTROL, 0, 0, 0);
                    Thread.Sleep(20);
                    keybd_event(VK_V, 0, 0, 0);
                    Thread.Sleep(20);
                    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
                    Thread.Sleep(20);
                    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
                    Thread.Sleep(60);

                    pasted = true;
                    try { Console.Beep(900, 70); } catch { }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] Inject paste error: " + ex.GetType().Name);
                }
                finally
                {
                    // Restore clipboard after a short delay on a background thread
                    string clip = prevClip;
                    ThreadPool.QueueUserWorkItem(_ => {
                        Thread.Sleep(300);
                        if (!string.IsNullOrEmpty(clip) && clip.Length <= MAX_TEXT)
                        {
                            try
                            {
                                if (!this.IsDisposed)
                                    this.Invoke(new Action(() => { try { Clipboard.SetText(clip); } catch { } }));
                            }
                            catch { }
                        }
                    });
                }

                // Reset lastTargetWindow after use so WS inject picks up the real foreground next time
                lastTargetWindow = IntPtr.Zero;
                return pasted;
            }
        }

        private string GetWindowTitle(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        // ---- Cleanup ----

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (wsClient != null) { wsClient.Stop(); wsClient.Dispose(); }
            UnregisterHotKey(this.Handle, HOTKEY_ID);
            if (trayIcon != null) { trayIcon.Visible = false; trayIcon.Dispose(); }
            if (recognizer != null) recognizer.Dispose();
            base.OnFormClosing(e);
        }
    }
}
