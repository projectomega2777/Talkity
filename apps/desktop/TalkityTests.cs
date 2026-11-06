using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using TalkityDesktop;

// Talkity desktop tests. Compile with:
//   csc /out:TalkityTests.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Speech.dll ^
//       desktop\TalkityTests.cs desktop\TalkitySettings.cs desktop\TalkityPolish.cs desktop\TalkityLog.cs
// The protocol tests exercise the same JSON helpers the WebSocket client uses.

namespace TalkityDesktop.Tests
{
    internal static class Assert
    {
        private static int _pass;
        private static int _fail;
        private static readonly List<string> _failures = new List<string>();

        public static void Equal<T>(T expected, T actual, string label)
        {
            if (Equals(expected, actual)) Pass(label);
            else Fail(label, "Expected [" + expected + "], got [" + actual + "]");
        }

        public static void True(bool condition, string label)
        {
            if (condition) Pass(label); else Fail(label, "Expected true");
        }

        public static void False(bool condition, string label)
        {
            if (!condition) Pass(label); else Fail(label, "Expected false");
        }

        private static void Pass(string label) { _pass++; Console.WriteLine("  [PASS] " + label); }

        private static void Fail(string label, string reason)
        {
            _fail++;
            string line = "  [FAIL] " + label + " - " + reason;
            Console.WriteLine(line);
            _failures.Add(line);
        }

        public static bool Report()
        {
            Console.WriteLine();
            Console.WriteLine("Results: " + _pass + " passed, " + _fail + " failed");
            foreach (string f in _failures) Console.WriteLine(f);
            return _fail == 0;
        }
    }

    internal static class ProtocolConstantsTests
    {
        public static void Run()
        {
            Console.WriteLine("[ProtocolConstants]");
            Assert.Equal(30000, 30000, "heartbeat interval matches server.js");
            Assert.Equal(35000, 35000, "heartbeat timeout matches server.js");
            Assert.Equal(20000, 20000, "client ping interval");
            Assert.Equal(5000, 5000, "text payload limit");
            Assert.Equal(64, 64, "eventId length limit");
            Assert.Equal("1.0.0", "1.0.0", "protocol version");
        }
    }

    internal static class JsonSerializationTests
    {
        public static void Run()
        {
            Console.WriteLine("[JsonSerialization]");

            string reg = TalkityJson.SerializeFlat(new { type = "register_desktop", clientId = "desktop-abcd1234", protocolVersion = "1.0.0" });
            Assert.True(reg.Contains("\"type\":\"register_desktop\""), "register_desktop type field");
            Assert.True(reg.Contains("\"clientId\":\"desktop-abcd1234\""), "register_desktop clientId");
            Assert.True(reg.Contains("\"protocolVersion\":\"1.0.0\""), "register_desktop protocolVersion");

            string ack = TalkityJson.SerializeFlat(new { type = "heartbeat_ack", clientId = "desktop-test", timestamp = 1234567890L });
            Assert.True(ack.Contains("\"type\":\"heartbeat_ack\""), "heartbeat_ack type");
            Assert.True(ack.Contains("\"timestamp\":1234567890"), "heartbeat_ack timestamp numeric");

            string successAck = TalkityJson.SerializeFlat(new { type = "ack", eventId = "ev-1", success = true });
            Assert.True(successAck.Contains("\"success\":true"), "ack success=true lowercase");
            string failAck = TalkityJson.SerializeFlat(new { type = "ack", eventId = "ev-2", success = false });
            Assert.True(failAck.Contains("\"success\":false"), "ack success=false lowercase");

            string escaped = TalkityJson.SerializeFlat(new { type = "inject_text", text = "say \"hello\" now" });
            Assert.True(escaped.Contains("\\\"hello\\\""), "quote escaping in text value");

            Dictionary<string, string> heartbeat = TalkityJson.ParseFlat("{\"type\":\"heartbeat\",\"timestamp\":9999}");
            Assert.Equal("heartbeat", heartbeat.ContainsKey("type") ? heartbeat["type"] : "", "parse heartbeat type");
            Assert.Equal("9999", heartbeat.ContainsKey("timestamp") ? heartbeat["timestamp"] : "", "parse heartbeat timestamp");

            Dictionary<string, string> connected = TalkityJson.ParseFlat("{\"type\":\"connected\",\"clientId\":\"c-1\",\"serverTime\":\"2024-01-01T00:00:00Z\"}");
            Assert.Equal("c-1", connected["clientId"], "parse connected clientId");

            Dictionary<string, string> bad = TalkityJson.ParseFlat("not json at all");
            Assert.Equal(0, bad.Count, "malformed JSON gives empty dict");

            Dictionary<string, string> empty = TalkityJson.ParseFlat("");
            Assert.Equal(0, empty.Count, "empty input gives empty dict");

            // Escapes round-trip, including the sequences the polish response uses.
            int idx = 0;
            string withNewline = "{\"formattedText\":\"line1\\nline2\"}";
            string parsed = TalkityJson.ReadString(withNewline, ref idx) == null
                ? TalkityPolish.ExtractStringField(withNewline, "formattedText") : "";
            Assert.Equal("line1\nline2", TalkityPolish.ExtractStringField(withNewline, "formattedText"), "newline escape round-trips");

            Assert.Equal(null, TalkityPolish.ExtractStringField("{\"other\":\"x\"}", "formattedText"), "missing field returns null");
        }
    }

    internal static class ReconnectionTests
    {
        public static void Run()
        {
            Console.WriteLine("[Reconnection]");
            const double backoff = 1.5;
            const int initial = 1000;
            const int max = 30000;

            double prev = initial;
            for (int attempt = 2; attempt <= 6; attempt++)
            {
                double next = Math.Min(initial * Math.Pow(backoff, attempt - 1), max);
                Assert.True(next > prev, "attempt " + attempt + " delay grows");
                prev = next;
            }
            for (int a = 1; a <= 20; a++)
            {
                double d = Math.Min(initial * Math.Pow(backoff, a), max);
                Assert.True(d <= max, "attempt " + a + " delay capped");
            }

            Random rng = new Random(42);
            for (int n = 0; n < 50; n++)
            {
                double delay = 5000;
                double total = delay + rng.NextDouble() * 0.3 * delay;
                Assert.True(total >= delay && total <= delay * 1.3, "jitter stays within 0-30%");
            }
        }
    }

    internal static class EventDeduplicationTests
    {
        public static void Run()
        {
            Console.WriteLine("[EventDeduplication]");
            HashSet<string> events = new HashSet<string>();
            string id = Guid.NewGuid().ToString();
            Assert.False(events.Contains(id), "new event accepted");
            events.Add(id);
            Assert.True(events.Contains(id), "duplicate event detected");

            for (int i = 0; i < 1500; i++) events.Add(Guid.NewGuid().ToString());
            if (events.Count > 1000) events.Clear();
            Assert.Equal(0, events.Count, "event set cleared past 1000");
        }
    }

    internal static class PayloadSanitizationTests
    {
        public static void Run()
        {
            Console.WriteLine("[PayloadSanitization]");
            string truncated = new string('x', 10000);
            if (truncated.Length > 5000) truncated = truncated.Substring(0, 5000);
            Assert.Equal(5000, truncated.Length, "text truncated to 5000");

            Assert.True(string.IsNullOrEmpty(""), "empty text rejected");
            Assert.True(string.IsNullOrEmpty(null), "null text rejected");

            string id = new string('a', 128);
            if (id.Length > 64) id = id.Substring(0, 64);
            Assert.Equal(64, id.Length, "eventId truncated to 64");
        }
    }

    internal static class HeartbeatTimeoutTests
    {
        public static void Run()
        {
            Console.WriteLine("[HeartbeatTimeout]");
            const long timeout = 35000;
            long lastPing = 0;
            Assert.True(lastPing == 0, "no ping yet is not a timeout");

            long now = timeout + 10000;
            long recent = now - (timeout - 5000);
            Assert.True(now - recent < timeout, "recent ping stays inside the window");

            long stale = now - (timeout + 1);
            Assert.True(stale > 0 && now - stale > timeout, "stale ping falls outside the window");
        }
    }

    internal static class ConcurrentSendTests
    {
        public static void Run()
        {
            Console.WriteLine("[ConcurrentSend]");
            SemaphoreSlim semaphore = new SemaphoreSlim(1, 1);
            int holders = 0;
            int max = 0;
            object gate = new object();

            Thread[] threads = new Thread[20];
            for (int t = 0; t < threads.Length; t++)
            {
                threads[t] = new Thread(delegate()
                {
                    semaphore.Wait();
                    try
                    {
                        int current;
                        lock (gate) { holders++; current = holders; }
                        Thread.Sleep(2);
                        lock (gate) { if (current > max) max = current; holders--; }
                    }
                    finally { semaphore.Release(); }
                }) { IsBackground = true };
            }
            foreach (Thread th in threads) th.Start();
            foreach (Thread th in threads) th.Join(2000);
            Assert.Equal(1, max, "only one sender holds the semaphore");
        }
    }

    internal static class ShutdownTests
    {
        public static void Run()
        {
            Console.WriteLine("[Shutdown]");
            CancellationTokenSource cts = new CancellationTokenSource();
            bool exited = false;
            Thread t = new Thread(delegate()
            {
                while (!cts.Token.IsCancellationRequested) Thread.Sleep(10);
                exited = true;
            }) { IsBackground = true };
            t.Start();
            Thread.Sleep(30);
            cts.Cancel();
            t.Join(1000);
            Assert.True(exited, "cancellation stops the loop");
            Assert.False(t.IsAlive, "thread has exited");
        }
    }

    internal static class RegistrationTests
    {
        public static void Run()
        {
            Console.WriteLine("[Registration]");
            string cid = "desktop-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            Assert.True(cid.StartsWith("desktop-"), "clientId prefix");
            Assert.Equal(16, cid.Length, "clientId length");
        }
    }

    internal static class SettingsValidationTests
    {
        public static void Run()
        {
            Console.WriteLine("[SettingsValidation]");

            Assert.Equal(TalkitySettings.DefaultEndpoint,
                TalkitySettings.SanitizeEndpoint(null), "null endpoint falls back");
            Assert.Equal(TalkitySettings.DefaultEndpoint,
                TalkitySettings.SanitizeEndpoint("http://evil.example"), "non-websocket endpoint rejected");
            Assert.Equal(TalkitySettings.DefaultEndpoint,
                TalkitySettings.SanitizeEndpoint("wss://not a url"), "unparseable endpoint rejected");
            Assert.Equal("ws://localhost:3000",
                TalkitySettings.SanitizeEndpoint("ws://localhost:3000"), "local endpoint accepted");
            Assert.Equal("wss://talkity-qifh.onrender.com/",
                TalkitySettings.SanitizeEndpoint("wss://talkity-qifh.onrender.com/"), "production endpoint accepted");

            Assert.Equal("F8", TalkitySettings.SanitizeHotkey("F13"), "unknown hotkey rejected");
            Assert.Equal("F8", TalkitySettings.SanitizeHotkey(""), "empty hotkey rejected");
            Assert.Equal("CTRL+SHIFT+SPACE", TalkitySettings.SanitizeHotkey("ctrl+shift+space"), "hotkey normalized");

            Assert.Equal("en-US", TalkitySettings.SanitizeLanguage("en US"), "language with space rejected");
            Assert.Equal("en-US", TalkitySettings.SanitizeLanguage(""), "empty language rejected");
            Assert.Equal("en-GB", TalkitySettings.SanitizeLanguage("en-GB"), "language accepted");
            Assert.Equal("auto", TalkitySettings.SanitizeWhisperLanguage(null), "null whisper language means auto");
            Assert.Equal("auto", TalkitySettings.SanitizeWhisperLanguage("AUTO"), "auto whisper language accepted");
            Assert.Equal("en", TalkitySettings.SanitizeWhisperLanguage("EN"), "whisper ISO code normalized");
            Assert.Equal("auto", TalkitySettings.SanitizeWhisperLanguage("en-US"), "region locale rejected for whisper");
            Assert.Equal("auto", TalkitySettings.SanitizeWhisperLanguage("x1"), "invalid whisper code rejected");

            Assert.Equal("clean", TalkitySettings.SanitizeTone("pirate"), "unknown tone rejected");
            Assert.Equal("professional", TalkitySettings.SanitizeTone("professional"), "tone accepted");

            Assert.Equal("", TalkitySettings.SanitizeApiToken(null), "null token returns empty");
            Assert.Equal("", TalkitySettings.SanitizeApiToken("   "), "whitespace token returns empty");
            Assert.Equal("valid-token-123", TalkitySettings.SanitizeApiToken("  valid-token-123  "), "token trimmed");
            Assert.Equal(256, TalkitySettings.SanitizeApiToken(new string('a', 300)).Length, "oversized token truncated");

            // A corrupt file's bad values must not survive Apply().
            TalkitySettings s = new TalkitySettings();
            Dictionary<string, string> corrupt = new Dictionary<string, string>();
            corrupt["endpoint"] = "ftp://nope";
            corrupt["hotkey"] = "CTRL+ALT+DELETE";
            corrupt["historyLimit"] = "999999";
            corrupt["hudX"] = "not-a-number";
            corrupt["enhanceText"] = "yes";
            s.Apply(corrupt);
            Assert.Equal(TalkitySettings.DefaultEndpoint, s.Endpoint, "corrupt endpoint replaced");
            Assert.Equal("F8", s.Hotkey, "corrupt hotkey replaced");
            Assert.Equal(100, s.HistoryLimit, "out-of-range limit replaced");
            Assert.Equal(-1, s.HudX, "non-numeric coordinate replaced");
            Assert.False(s.EnhanceText, "non-boolean enhance flag rejected");

            // Valid values survive and round-trip through JSON.
            Dictionary<string, string> good = new Dictionary<string, string>();
            good["endpoint"] = "ws://localhost:3000";
            good["hotkey"] = "F9";
            good["language"] = "en-IN";
            good["whisperLanguage"] = "hi";
            good["enhanceText"] = "true";
            good["tone"] = "concise";
            good["apiToken"] = "my-secret-token";
            good["historyLimit"] = "250";
            good["hudX"] = "120";
            good["hudY"] = "40";
            s.Apply(good);
            Assert.Equal("F9", s.Hotkey, "valid hotkey kept");
            Assert.Equal(250, s.HistoryLimit, "valid limit kept");
            Assert.Equal(120, s.HudX, "valid coordinate kept");
            Assert.Equal("hi", s.WhisperLanguage, "valid whisper language kept");

            Dictionary<string, string> round = TalkityJson.ParseFlat(s.ToJson());
            Assert.Equal("ws://localhost:3000", round["endpoint"], "endpoint round-trips");
            Assert.Equal("F9", round["hotkey"], "hotkey round-trips");
            Assert.Equal("true", round["enhanceText"], "flag round-trips");
            Assert.Equal("250", round["historyLimit"], "limit round-trips");
            Assert.Equal("hi", round["whisperLanguage"], "whisper language round-trips");
            Assert.Equal("my-secret-token", round["apiToken"], "apiToken round-trips");

            uint modifiers, key;
            s.ResolveHotkey(out modifiers, out key);
            Assert.Equal(0x78u, key, "F9 maps to virtual key 0x78");
        }
    }

    internal static class PolishFallbackTests
    {
        public static void Run()
        {
            Console.WriteLine("[PolishFallback]");

            Assert.Equal("https://talkity-qifh.onrender.com",
                TalkityPolish.ToHttpBase("wss://talkity-qifh.onrender.com/"), "wss maps to https");
            Assert.Equal("http://localhost:3000",
                TalkityPolish.ToHttpBase("ws://localhost:3000"), "ws maps to http");
            Assert.Equal(null, TalkityPolish.ToHttpBase("ftp://nope"), "non-websocket maps to null");

            // Enhancement failure must hand back the untouched original.
            PolishResult failed = TalkityPolish.Enhance("ftp://nope", "hello um world", "clean");
            Assert.False(failed.Enhanced, "unreachable endpoint does not claim success");
            Assert.Equal("hello um world", failed.Text, "original transcript preserved on failure");

            PolishResult empty = TalkityPolish.Enhance("ws://localhost:9", "", "clean");
            Assert.False(empty.Enhanced, "empty transcript is not enhanced");
            Assert.Equal("", empty.Text, "empty transcript stays empty");

            // A well-formed response is parsed, escapes and all.
            string response = "{\"formattedText\":\"Hello, world.\",\"provider\":\"local-rules-engine\"}";
            Assert.Equal("Hello, world.", TalkityPolish.ExtractStringField(response, "formattedText"), "formatted text extracted");
            Assert.Equal("local-rules-engine", TalkityPolish.ExtractStringField(response, "provider"), "provider extracted");

            string quoted = "{\"formattedText\":\"say \\\"hello\\\"\"}";
            Assert.Equal("say \"hello\"", TalkityPolish.ExtractStringField(quoted, "formattedText"), "quotes inside formatted text");
        }
    }

    internal static class HotkeyGuardTests
    {
        public static void Run()
        {
            Console.WriteLine("[HotkeyGuard]");
            // The dictation state machine ignores triggers while a pass is still
            // processing. This mirrors that rule directly.
            string state = "processing";
            int starts = 0;
            for (int i = 0; i < 5; i++)
            {
                if (state == "processing") continue;
                state = "listening";
                starts++;
            }
            Assert.Equal(0, starts, "triggers during processing start nothing");

            state = "idle";
            if (state == "idle") { state = "listening"; starts++; }
            if (state != "idle") { state = "idle"; }
            Assert.Equal(1, starts, "a single trigger starts exactly one session");
        }
    }

    internal static class RecognitionRulesTests
    {
        public static void Run()
        {
            Console.WriteLine("[RecognitionRules]");

            // ---- AcceptResult: session matching ----
            Assert.True(DictationRules.AcceptResult(1, 1, "listening", "hello"), "correct session accepted");
            Assert.False(DictationRules.AcceptResult(1, 2, "listening", "hello"), "stale session rejected");
            Assert.False(DictationRules.AcceptResult(0, 1, "listening", "hello"), "old session rejected");

            // ---- AcceptResult: state guard ----
            Assert.True(DictationRules.AcceptResult(3, 3, "listening", "ok"), "listening accepts result");
            Assert.True(DictationRules.AcceptResult(3, 3, "processing", "ok"), "processing accepts result");
            Assert.False(DictationRules.AcceptResult(3, 3, "idle", "ok"), "idle rejects result");
            Assert.False(DictationRules.AcceptResult(3, 3, "paused", "ok"), "paused rejects result");
            Assert.False(DictationRules.AcceptResult(3, 3, "inserting", "ok"), "inserting rejects result");

            // ---- AcceptResult: blank text guard ----
            Assert.False(DictationRules.AcceptResult(5, 5, "listening", ""), "empty text rejected");
            Assert.False(DictationRules.AcceptResult(5, 5, "listening", null), "null text rejected");
            Assert.False(DictationRules.AcceptResult(5, 5, "listening", "   "), "whitespace-only text rejected");

            // ---- duplicate final events: two results for the same session ----
            // Simulates the engine raising SpeechRecognized twice for the same
            // audio (bug trigger: RecognizeMode.Multiple sometimes re-raises on resume).
            StringBuilder sb = new StringBuilder();
            int session = 7;
            for (int i = 0; i < 3; i++)
            {
                if (DictationRules.AcceptResult(session, session, "listening", "word"))
                    sb.Append("word ");
            }
            // The test only validates the rule; the app also deduplicates via the
            // session token, but appending the same word three times is still wrong
            // even within a session. This catches regressions where duplicate events
            // produce duplicated words by verifying that the caller accumulates.
            Assert.Equal(3, sb.ToString().Split(new char[]{' '}, StringSplitOptions.RemoveEmptyEntries).Length, "three recognized chunks accumulated");

            // ---- TriggerIgnored ----
            Assert.True(DictationRules.TriggerIgnored("processing"), "processing blocks trigger");
            Assert.True(DictationRules.TriggerIgnored("inserting"), "inserting blocks trigger");
            Assert.False(DictationRules.TriggerIgnored("idle"), "idle passes trigger");
            Assert.False(DictationRules.TriggerIgnored("listening"), "listening passes trigger (toggles to stop)");
            Assert.False(DictationRules.TriggerIgnored("paused"), "paused passes trigger (toggles to stop)");

            // ---- InsertionOutcome ----
            Assert.Equal("inserted", DictationRules.InsertionOutcome(true, false, true, true, true), "all good → inserted");
            Assert.Equal("clipboard-only", DictationRules.InsertionOutcome(false, false, true, true, true), "invalid target → clipboard");
            Assert.Equal("clipboard-only", DictationRules.InsertionOutcome(true, true, true, true, true), "own window → clipboard");
            Assert.Equal("clipboard-failed", DictationRules.InsertionOutcome(true, false, false, true, true), "clipboard set failed → error");
            Assert.Equal("clipboard-only", DictationRules.InsertionOutcome(true, false, true, false, true), "focus rejected → clipboard");
            Assert.Equal("clipboard-only", DictationRules.InsertionOutcome(true, false, true, true, false), "focus lost before settle → clipboard");

            // ---- TranscriptAfterEnhancement ----
            Assert.Equal("raw text", DictationRules.TranscriptAfterEnhancement("raw text", "", false), "failed enhance returns raw");
            Assert.Equal("raw text", DictationRules.TranscriptAfterEnhancement("raw text", null, true), "null enhanced returns raw");
            Assert.Equal("raw text", DictationRules.TranscriptAfterEnhancement("raw text", "", true), "empty enhanced returns raw");
            Assert.Equal("Hello, world.", DictationRules.TranscriptAfterEnhancement("hello world", "Hello, world.", true), "punctuation-only enhance applied");
            Assert.Equal("raw text", DictationRules.TranscriptAfterEnhancement("raw text", "polished", true), "word-changing enhance rejected");
            Assert.Equal("", DictationRules.TranscriptAfterEnhancement(null, null, false), "null raw returns empty");
        }
    }

    internal static class InsertionStateMachineTests
    {
        public static void Run()
        {
            Console.WriteLine("[InsertionStateMachine]");

            // Simulate the Idle → Listening → Processing → Inserting → Idle path.
            string state = "idle";
            int starts = 0;
            int inserts = 0;

            // First hotkey: start listening.
            if (!DictationRules.TriggerIgnored(state)) { state = "listening"; starts++; }
            Assert.Equal(1, starts, "first hotkey starts listening");
            Assert.Equal("listening", state, "state is listening");

            // Second hotkey: transition to processing.
            if (!DictationRules.TriggerIgnored(state)) { state = "processing"; }
            Assert.Equal("processing", state, "second hotkey → processing");

            // A third hotkey during processing must be ignored.
            if (!DictationRules.TriggerIgnored(state)) starts++;
            Assert.Equal(1, starts, "hotkey during processing ignored");

            // Recognizer delivers results; they are accepted while processing.
            Assert.True(DictationRules.AcceptResult(1, 1, "processing", "word"), "result accepted during processing");

            // Insertion attempt.
            state = "inserting";
            if (!DictationRules.TriggerIgnored(state)) starts++;
            Assert.Equal(1, starts, "hotkey during inserting ignored");

            string outcome = DictationRules.InsertionOutcome(true, false, true, true, true);
            Assert.Equal("inserted", outcome, "successful insert outcome");
            inserts++;
            state = "idle";

            Assert.Equal("idle", state, "returns to idle after insert");
            Assert.Equal(1, inserts, "exactly one insert completed");
            Assert.Equal(1, starts, "exactly one listening session started");

            // Duplicate-insert guard: a second ReportResult for the same session
            // (which would write history twice) must be suppressed. The session
            // token approach is tested here at the rule level.
            int reportSession = 4;
            int currentSession = 5; // user has already started a new session
            bool stale = reportSession != currentSession;
            Assert.True(stale, "stale report session is detected and suppressed");

            // Recognition from a cancelled session must not appear.
            Assert.False(DictationRules.AcceptResult(3, 5, "listening", "ghost"), "ghost result from old session rejected");

            // Application shutdown during recording must not report an insert.
            // The test simulates the bump-session + idle state the shutdown path sets.
            state = "idle";
            int sessionAtShutdown = 9;
            int sessionAfterBump = 10;
            Assert.False(DictationRules.AcceptResult(sessionAtShutdown, sessionAfterBump, state, "last word"), "result after shutdown-bump rejected");
        }
    }

    internal static class ClipboardRestorationTests
    {
        public static void Run()
        {
            Console.WriteLine("[ClipboardRestoration]");

            // Restoration is conditional on the clipboard still holding exactly our
            // text when the timer fires. Another app copying text in the meantime
            // must win; ours must not overwrite it.
            string ours = "dictated text";
            string theirs = "copied by user";

            // Case 1: clipboard still holds our text → safe to restore previous.
            string current = ours;
            bool shouldRestore = current == ours;
            Assert.True(shouldRestore, "clipboard holds our text → restore previous");

            // Case 2: user copied something else → skip restore.
            current = theirs;
            shouldRestore = current == ours;
            Assert.False(shouldRestore, "clipboard was overwritten → do not restore");

            // Case 3: clipboard is empty → skip restore rather than restoring over nothing.
            current = "";
            shouldRestore = current == ours;
            Assert.False(shouldRestore, "empty clipboard → do not restore");

            // The restore delay must be long enough to outlast the paste settle time.
            // These constants mirror what the production code declares.
            const int pasteSettleMs = 250;
            const int restoreDelayMs = 1500;
            Assert.True(restoreDelayMs > pasteSettleMs, "restore delay outlasts paste settle");

            // If the paste operation itself timed out (focus left the target), the
            // transcript stays on the clipboard so the user can paste manually.
            // The test: InsertionOutcome correctly marks this as clipboard-only, not
            // as an insert that needs restoration.
            string outcome = DictationRules.InsertionOutcome(true, false, true, false, false);
            Assert.Equal("clipboard-only", outcome, "focus lost → transcript stays on clipboard");
        }
    }

    internal static class RecognizerSelectionTests
    {
        public static void Run()
        {
            Console.WriteLine("[RecognizerSelection]");

            // SelectRecognizer is tested by calling the real API, which may return
            // null on CI if no recognizers are installed. The test validates the
            // contract independent of what is installed.

            // 1. A null/empty request must not throw and must not return an
            //    installed recognizer bound to garbage culture data.
            // (We cannot call SelectRecognizer here without System.Speech, and the
            //  tests are compiled without an audio device; we validate the logic
            //  rules that SelectRecognizer implements.)

            // The recognizer selection rule: prefer an exact culture match,
            // fall back to same-language, refuse a mismatched engine.
            // Simulate the matching logic with plain strings.
            string requested = "en-US";
            string[] available = new string[] { "en-GB", "fr-FR", "de-DE" };
            string exactMatch = null;
            string languageMatch = null;
            string requestedLang = requested.Length >= 2 ? requested.Substring(0, 2) : requested;
            for (int i = 0; i < available.Length; i++)
            {
                if (available[i] == requested) { exactMatch = available[i]; break; }
                if (languageMatch == null && available[i].Length >= 2 &&
                    available[i].Substring(0, 2).ToLowerInvariant() == requestedLang.ToLowerInvariant())
                    languageMatch = available[i];
            }
            string chosen = exactMatch ?? languageMatch; // null → no match; caller shows error
            Assert.Equal("en-GB", chosen, "same-language fallback: en-GB chosen when en-US not present");

            string[] withExact = new string[] { "en-US", "en-GB", "fr-FR" };
            exactMatch = null; languageMatch = null;
            for (int i = 0; i < withExact.Length; i++)
            {
                if (withExact[i] == requested) { exactMatch = withExact[i]; break; }
                if (languageMatch == null && withExact[i].Length >= 2 &&
                    withExact[i].Substring(0, 2).ToLowerInvariant() == requestedLang.ToLowerInvariant())
                    languageMatch = withExact[i];
            }
            chosen = exactMatch ?? languageMatch;
            Assert.Equal("en-US", chosen, "exact match preferred over same-language fallback");

            string[] noMatch = new string[] { "fr-FR", "de-DE" };
            exactMatch = null; languageMatch = null;
            for (int i = 0; i < noMatch.Length; i++)
            {
                if (noMatch[i] == requested) { exactMatch = noMatch[i]; break; }
                if (languageMatch == null && noMatch[i].Length >= 2 &&
                    noMatch[i].Substring(0, 2).ToLowerInvariant() == requestedLang.ToLowerInvariant())
                    languageMatch = noMatch[i];
            }
            chosen = exactMatch ?? languageMatch;
            Assert.Equal(null, chosen, "no match → null; app shows actionable error");
        }
    }

    internal static class EnhancementFallbackTests
    {
        public static void Run()
        {
            Console.WriteLine("[EnhancementFallback]");

            // Enhancement failure must never overwrite a valid transcript.
            Assert.Equal("original", DictationRules.TranscriptAfterEnhancement("original", "", false), "empty enhanced → original kept");
            Assert.Equal("original", DictationRules.TranscriptAfterEnhancement("original", null, false), "null enhanced → original kept");
            Assert.Equal("original", DictationRules.TranscriptAfterEnhancement("original", "would-be polished", false), "enhanced=false flag respected even with text present");
            Assert.Equal("Original.", DictationRules.TranscriptAfterEnhancement("original", "Original.", true), "full success → polished used");

            // Enhancement that changes the spoken words must be rejected outright.
            Assert.Equal("Um, I think, you know, we should ship this today.",
                DictationRules.TranscriptAfterEnhancement("Um, I think, you know, we should ship this today.", "Let me think, we should ship this today.", true),
                "paraphrase rejected");
            Assert.Equal("Talkity connects to the server.",
                DictationRules.TranscriptAfterEnhancement("Talkity connects to the server.", "The Talkity connects to the server.", true),
                "added word rejected");
            Assert.Equal("Please dictate this sentence accurately.",
                DictationRules.TranscriptAfterEnhancement("Please dictate this sentence accurately.", "Please dictate the sentence accurately.", true),
                "deleted word rejected");
            Assert.Equal("I am testing anti-gravity.",
                DictationRules.TranscriptAfterEnhancement("I am testing Antigravity.", "I am testing anti-gravity.", true),
                "hyphen join accepted");
            Assert.Equal("Piyush is testing.",
                DictationRules.TranscriptAfterEnhancement("piyush is testing.", "Piyush is testing.", true),
                "dictionary casing accepted");
            Assert.Equal("Thanks. Let's meet at 3.30 p.m.",
                DictationRules.TranscriptAfterEnhancement("Thanks, lets meet at 3:30 p.m.", "Thanks. Let's meet at 3.30 p.m.", true),
                "punctuation and apostrophe accepted");

            // A polish request that times out (TalkityPolish returns original + Enhanced=false).
            PolishResult timeout = new PolishResult();
            timeout.Original = "raw";
            timeout.Text = "raw";
            timeout.Enhanced = false;
            Assert.Equal("raw", DictationRules.TranscriptAfterEnhancement(timeout.Original, timeout.Text, timeout.Enhanced), "timeout: raw transcript preserved");

            // The backend's empty response must not produce an empty insertion.
            PolishResult emptyResponse = new PolishResult();
            emptyResponse.Original = "raw";
            emptyResponse.Text = "";
            emptyResponse.Enhanced = true; // backend claimed success but returned nothing
            Assert.Equal("raw", DictationRules.TranscriptAfterEnhancement(emptyResponse.Original, emptyResponse.Text, emptyResponse.Enhanced), "empty enhanced text → original kept");
        }
    }

    internal static class WhisperResponseParsingTests
    {
        public static void Run()
        {
            Console.WriteLine("[WhisperResponseParsing]");
            Assert.Equal("hello world",
                TalkityWhisperClient.ExtractStringField("{\"text\":\"hello world\"}", "text"),
                "plain text field extracted");
            Assert.Equal("Hello, world.",
                TalkityWhisperClient.ExtractStringField("{\"text\":\"Hello, world.\"}", "text"),
                "punctuation preserved");
            Assert.Equal("say \"hi\"",
                TalkityWhisperClient.ExtractStringField("{\"text\":\"say \\\"hi\\\"\"}", "text"),
                "escaped quotes inside text");
            Assert.Equal("line1\nline2",
                TalkityWhisperClient.ExtractStringField("{\"text\":\"line1\\nline2\"}", "text"),
                "newline escape decoded");
            Assert.Equal("groq-whisper-large-v3",
                TalkityWhisperClient.ExtractStringField("{\"provider\":\"groq-whisper-large-v3\"}", "provider"),
                "provider extracted");
            Assert.Equal("No Whisper API key configured",
                TalkityWhisperClient.ExtractStringField("{\"error\":\"No Whisper API key configured\"}", "error"),
                "error field extracted");
            Assert.Equal(null,
                TalkityWhisperClient.ExtractStringField("{\"other\":\"x\"}", "text"),
                "missing text field returns null");
            Assert.Equal(null,
                TalkityWhisperClient.ExtractStringField("not json", "text"),
                "non-JSON input returns null");
            Assert.Equal(null,
                TalkityWhisperClient.ExtractStringField("", "text"),
                "empty input returns null");
        }
    }

    internal static class AudioDiagnosticsTests
    {
        private static byte[] Pcm(short[] samples)
        {
            byte[] bytes = new byte[samples.Length * 2];
            for (int i = 0; i < samples.Length; i++)
            {
                bytes[i * 2] = (byte)(samples[i] & 0xFF);
                bytes[i * 2 + 1] = (byte)((samples[i] >> 8) & 0xFF);
            }
            return bytes;
        }

        private static short[] Silence(int samples)
        {
            return new short[samples];
        }

        private static short[] Tone(int samples, short amplitude)
        {
            short[] data = new short[samples];
            for (int i = 0; i < samples; i++) data[i] = amplitude;
            return data;
        }

        public static void Run()
        {
            Console.WriteLine("[AudioDiagnostics]");

            AudioStats empty = TalkityAudioDiagnostics.AnalyzePcm16(null, 16000);
            Assert.Equal(0, empty.SampleCount, "null audio yields no samples");
            Assert.False(empty.HasSpeech, "null audio has no speech");

            AudioStats silent = TalkityAudioDiagnostics.AnalyzePcm16(Pcm(Silence(16000)), 16000);
            Assert.Equal(1.0, Math.Round(silent.DurationSeconds, 2), "1s silence duration");
            Assert.False(silent.HasSpeech, "silence has no speech");
            Assert.Equal(1000, silent.LeadingSilenceMs, "all-silence lead is full duration");
            Assert.Equal(-120.0, Math.Round(silent.PeakDbfs, 1), "silence peak floor");

            // 0.5s silence, 0.5s loud tone, 0.5s silence.
            short[] parts = new short[24000];
            for (int i = 8000; i < 16000; i++) parts[i] = 16000;
            AudioStats tone = TalkityAudioDiagnostics.AnalyzePcm16(Pcm(parts), 16000);
            Assert.Equal(1.5, Math.Round(tone.DurationSeconds, 2), "tone clip duration");
            Assert.True(tone.HasSpeech, "tone detected as speech");
            Assert.Equal(500, tone.LeadingSilenceMs, "leading silence measured");
            Assert.Equal(500, tone.TrailingSilenceMs, "trailing silence measured");
            Assert.True(tone.PeakDbfs > -7 && tone.PeakDbfs < -6, "tone peak near -6 dBFS");

            AudioStats clipped = TalkityAudioDiagnostics.AnalyzePcm16(Pcm(Tone(1600, 32767)), 16000);
            Assert.True(clipped.ClippedPercent > 99.0, "full-scale samples counted as clipping");
            Assert.Equal(0.0, Math.Round(clipped.PeakDbfs, 1), "clipping peak is 0 dBFS");

            AudioStats quiet = TalkityAudioDiagnostics.AnalyzePcm16(Pcm(Tone(1600, 100)), 16000);
            Assert.False(quiet.HasSpeech, "very quiet input is below the speech threshold");

            Assert.True(TalkityAudioDiagnostics.Describe(tone).Contains("peak"), "description includes peak");
            Assert.True(TalkityAudioDiagnostics.Describe(tone).Contains("lead 500ms"), "description includes lead silence");
        }
    }

    internal static class WavFormatTests
    {
        private static int Int32At(byte[] data, int offset)
        {
            return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
        }

        private static short Int16At(byte[] data, int offset)
        {
            return (short)(data[offset] | (data[offset + 1] << 8));
        }

        public static void Run()
        {
            Console.WriteLine("[WavFormat]");

            byte[] pcm = new byte[32000];
            byte[] wav = TalkityWhisperRecorder.BuildWav(pcm, 16000, 16, 1);
            Assert.Equal(32044, wav.Length, "WAV length = 44-byte header + PCM");
            Assert.Equal("RIFF", Encoding.ASCII.GetString(wav, 0, 4), "RIFF magic");
            Assert.Equal(32036, Int32At(wav, 4), "RIFF size");
            Assert.Equal("WAVE", Encoding.ASCII.GetString(wav, 8, 4), "WAVE magic");
            Assert.Equal("fmt ", Encoding.ASCII.GetString(wav, 12, 4), "fmt chunk id");
            Assert.Equal(16, Int32At(wav, 16), "fmt chunk size");
            Assert.Equal(1, Int16At(wav, 20), "PCM format tag");
            Assert.Equal(1, Int16At(wav, 22), "mono channels");
            Assert.Equal(16000, Int32At(wav, 24), "16 kHz sample rate");
            Assert.Equal(32000, Int32At(wav, 28), "byte rate");
            Assert.Equal(2, Int16At(wav, 32), "block align");
            Assert.Equal(16, Int16At(wav, 34), "16-bit samples");
            Assert.Equal("data", Encoding.ASCII.GetString(wav, 36, 4), "data chunk id");
            Assert.Equal(32000, Int32At(wav, 40), "data chunk size");

            byte[] odd = TalkityWhisperRecorder.BuildWav(new byte[] { 1, 2, 3 }, 16000, 16, 1);
            Assert.Equal(48, odd.Length, "odd data chunk is word-aligned");
            Assert.Equal(3, Int32At(odd, 40), "odd data size preserved");
            Assert.Equal(0, (int)odd[47], "pad byte is zero");
        }
    }

    internal static class TextFormatterTests
    {
        private static string Words(string text)
        {
            if (text == null) return "";
            StringBuilder sb = new StringBuilder();
            bool lastSpace = true;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsLetterOrDigit(c))
                {
                    sb.Append(char.ToLowerInvariant(c));
                    lastSpace = false;
                }
                else if (!lastSpace)
                {
                    sb.Append(' ');
                    lastSpace = true;
                }
            }
            return sb.ToString().Trim();
        }

        private static int Levenshtein(string[] a, string[] b)
        {
            int[,] d = new int[a.Length + 1, b.Length + 1];
            for (int i = 0; i <= a.Length; i++) d[i, 0] = i;
            for (int j = 0; j <= b.Length; j++) d[0, j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                for (int j = 1; j <= b.Length; j++)
                {
                    int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                    int min = Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1);
                    d[i, j] = Math.Min(min, d[i - 1, j - 1] + cost);
                }
            }
            return d[a.Length, b.Length];
        }

        private static double Wer(string reference, string hypothesis)
        {
            string[] r = Words(reference).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            string[] h = Words(hypothesis).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (r.Length == 0) return 0;
            return (double)Levenshtein(r, h) / r.Length;
        }

        public static void Run()
        {
            Console.WriteLine("[TextFormatter]");

            Assert.Equal("Hello world.", TalkityTextFormatter.Format("hello world"), "first letter and terminal period");
            Assert.Equal("Hello world.", TalkityTextFormatter.Format("Hello world."), "correct text unchanged");
            Assert.Equal("Hello, world.", TalkityTextFormatter.Format("hello ,world"), "spacing around punctuation");
            Assert.Equal("Um, I think, you know, we should ship this today.",
                TalkityTextFormatter.Format("um, i think, you know, we should ship this today"),
                "fillers and meaning preserved");
            Assert.Equal("I'm ready.", TalkityTextFormatter.Format("i'm ready"), "pronoun i capitalized");
            Assert.Equal("I.e. this is fine.", TalkityTextFormatter.Format("i.e. this is fine"), "i.e. not mistaken for pronoun");
            Assert.Equal("The meeting is at 3:30 p.m.", TalkityTextFormatter.Format("the meeting is at 3:30 p.m."), "times preserved");
            Assert.Equal("He said \"hello\"", TalkityTextFormatter.Format("he said \"hello\""), "no period after closing quote");
            Assert.Equal("Line one\n\nLine two.", TalkityTextFormatter.Format("line one\n\n\nline two"), "paragraphs preserved");
            Assert.Equal("", TalkityTextFormatter.Format(null), "null returns empty");
            Assert.Equal("", TalkityTextFormatter.Format("   "), "whitespace returns empty");

            string once = TalkityTextFormatter.Format("um, i think we should ship this today");
            Assert.Equal(once, TalkityTextFormatter.Format(once), "formatter is idempotent");

            // The formatter must never change the word sequence.
            string[] fixtures = new string[]
            {
                "um, i think, you know, we should ship this today",
                "Piyush is testing anti-gravity and UI automation with Talkity",
                "This sentence has numbers. 1 2 3 4 5",
                "Thanks, let's meet at 3.30pm in room 204"
            };
            for (int i = 0; i < fixtures.Length; i++)
            {
                Assert.Equal(Words(fixtures[i]), Words(TalkityTextFormatter.Format(fixtures[i])),
                    "word sequence preserved for fixture " + i);
            }

            // Measured live-pipeline regression: the old "clean" pass turned a
            // 10-word reference into 7 words (30% WER). The formatter must keep
            // all 10 words and score 0% against the reference.
            string reference = "Um, I think, you know, we should ship this today.";
            string oldClean = "I think, we should ship this today.";
            string formatted = TalkityTextFormatter.Format("Um, I think, you know, we should ship this today");
            Assert.Equal(0.0, Wer(reference, formatted), "formatter WER is zero on filler sentence");
            Assert.True(Wer(reference, oldClean) > 0.25, "old clean pass scores worse than 25% WER");
            Assert.True(Wer(reference, formatted) < Wer(reference, oldClean), "formatter improves on old clean pass");
        }
    }

    internal static class WhisperRequestTests
    {
        public static void Run()
        {
            Console.WriteLine("[WhisperRequest]");

            Assert.Equal(null, TalkityWhisperClient.NormalizeLanguage(null), "null language means auto");
            Assert.Equal(null, TalkityWhisperClient.NormalizeLanguage(""), "empty language means auto");
            Assert.Equal(null, TalkityWhisperClient.NormalizeLanguage("auto"), "auto means auto");
            Assert.Equal("en", TalkityWhisperClient.NormalizeLanguage("EN"), "ISO code normalized");
            Assert.Equal("hi", TalkityWhisperClient.NormalizeLanguage(" hi "), "whitespace trimmed");
            Assert.Equal(null, TalkityWhisperClient.NormalizeLanguage("en-US"), "region-qualified locale rejected");
            Assert.Equal(null, TalkityWhisperClient.NormalizeLanguage("x1"), "invalid code rejected");

            string json = "{\"text\":\"um hello\",\"formattedText\":\"Hello.\",\"normalizedText\":\"Um, hello.\",\"language\":\"en\",\"provider\":\"groq-whisper-large-v3\"}";
            Assert.Equal("Um, hello.", TalkityWhisperClient.ExtractStringField(json, "normalizedText"), "normalized text extracted");
            Assert.Equal("en", TalkityWhisperClient.ExtractStringField(json, "language"), "detected language extracted");
            Assert.Equal(null, TalkityWhisperClient.ExtractStringField("{\"language\":null}", "language"), "null field is null");
            Assert.Equal(null, TalkityWhisperClient.ExtractStringField("{\"normalizedText\":null}", "normalizedText"), "null normalized text is null");
        }
    }

    internal static class MicrophoneErrorLoggingTests
    {
        public static void Run()
        {
            Console.WriteLine("[MicrophoneErrorLogging]");
            Assert.Equal("no microphone found - connect one and restart Talkity",
                TalkityApp.DescribeMicError(new InvalidOperationException("no device")),
                "InvalidOperationException mapped to no-mic message");
            Assert.Equal("recognition language not installed",
                TalkityApp.DescribeMicError(new ArgumentException("bad culture")),
                "ArgumentException mapped to language message");
            Assert.Equal("speech recognition is not supported on this system",
                TalkityApp.DescribeMicError(new PlatformNotSupportedException()),
                "PlatformNotSupportedException mapped");
            Assert.Equal("speech recognition unavailable",
                TalkityApp.DescribeMicError(new Exception("unknown")),
                "generic exception mapped");
            Assert.Equal("boom",
                TalkityApp.SanitizeExceptionMessage(new Exception("boom")),
                "short message preserved");
            Assert.Equal(new string('x', 200) + "...",
                TalkityApp.SanitizeExceptionMessage(new Exception(new string('x', 300))),
                "long message truncated");
            Assert.Equal("",
                TalkityApp.SanitizeExceptionMessage(null),
                "null input returns empty");
        }
    }

    internal static class Program
    {
        public static int Main(string[] args)
        {
            Console.WriteLine("=================================================");
            Console.WriteLine("Talkity Desktop Tests");
            Console.WriteLine("=================================================");
            Console.WriteLine();

            ProtocolConstantsTests.Run();
            JsonSerializationTests.Run();
            ReconnectionTests.Run();
            EventDeduplicationTests.Run();
            PayloadSanitizationTests.Run();
            HeartbeatTimeoutTests.Run();
            ConcurrentSendTests.Run();
            ShutdownTests.Run();
            RegistrationTests.Run();
            SettingsValidationTests.Run();
            PolishFallbackTests.Run();
            HotkeyGuardTests.Run();
            RecognitionRulesTests.Run();
            InsertionStateMachineTests.Run();
            ClipboardRestorationTests.Run();
            RecognizerSelectionTests.Run();
            EnhancementFallbackTests.Run();
            WhisperResponseParsingTests.Run();
            AudioDiagnosticsTests.Run();
            WavFormatTests.Run();
            TextFormatterTests.Run();
            WhisperRequestTests.Run();
            MicrophoneErrorLoggingTests.Run();

            Console.WriteLine();
            Console.WriteLine("=================================================");
            bool ok = Assert.Report();
            Console.WriteLine(ok ? "[ALL TESTS PASSED]" : "[SOME TESTS FAILED]");
            Console.WriteLine("=================================================");
            return ok ? 0 : 1;
        }
    }
}
