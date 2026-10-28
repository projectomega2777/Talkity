using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace TalkityDesktop
{
    /// <summary>
    /// User preferences persisted as flat JSON in %APPDATA%\Talkity\settings.json.
    /// Loaded values are validated; missing, corrupt, or out-of-range fields fall
    /// back to defaults so a bad file can never stop the application starting.
    /// </summary>
    internal sealed class TalkitySettings
    {
        public const string DefaultEndpoint = "wss://talkity-qifh.onrender.com/";
        public const string DefaultHotkey = "F8";

        public string Endpoint = DefaultEndpoint;
        public string Hotkey = DefaultHotkey;
        public string Language = "en-US";
        /// <summary>
        /// Optional Whisper language override. "auto" (the default) lets Whisper
        /// detect the language, which is required for Hindi/Hinglish dictation.
        /// Only an explicit ISO-639-1 code (e.g. "en", "hi") is sent to the API.
        /// </summary>
        public string WhisperLanguage = "auto";
        public bool EnhanceText = false;
        public string Tone = "clean";
        public bool LaunchAtStartup = false;
        public bool MinimizeToTray = true;
        public bool ShowHud = true;
        public int HudX = -1;
        public int HudY = -1;
        public bool KeepHistory = true;
        public int HistoryLimit = 100;
        public bool SoundCues = true;

        // Phase 3: Transcription engine selection
        public const string DefaultTranscriptionEngine = "system_speech";
        public string TranscriptionEngine = DefaultTranscriptionEngine; // "system_speech" or "whisper"

        private static string FilePath
        {
            get
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Talkity");
                return Path.Combine(dir, "settings.json");
            }
        }

        public static TalkitySettings Load()
        {
            TalkitySettings s = new TalkitySettings();
            try
            {
                if (!File.Exists(FilePath)) return s;
                Dictionary<string, string> raw = TalkityJson.ParseFlat(File.ReadAllText(FilePath, Encoding.UTF8));
                s.Apply(raw);
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("Settings unreadable, using defaults: " + ex.GetType().Name);
            }
            return s;
        }

        /// <summary>Apply raw key/value pairs, rejecting anything outside the allowed ranges.</summary>
        public void Apply(Dictionary<string, string> raw)
        {
            string v;
            if (raw.TryGetValue("endpoint", out v)) Endpoint = SanitizeEndpoint(v);
            if (raw.TryGetValue("hotkey", out v)) Hotkey = SanitizeHotkey(v);
            if (raw.TryGetValue("language", out v)) Language = SanitizeLanguage(v);
            if (raw.TryGetValue("whisperLanguage", out v)) WhisperLanguage = SanitizeWhisperLanguage(v);
            if (raw.TryGetValue("enhanceText", out v)) EnhanceText = v == "true";
            if (raw.TryGetValue("tone", out v)) Tone = SanitizeTone(v);
            if (raw.TryGetValue("launchAtStartup", out v)) LaunchAtStartup = v == "true";
            if (raw.TryGetValue("minimizeToTray", out v)) MinimizeToTray = v == "true";
            if (raw.TryGetValue("showHud", out v)) ShowHud = v == "true";
            if (raw.TryGetValue("hudX", out v)) HudX = ClampInt(v, -1, 20000, -1);
            if (raw.TryGetValue("hudY", out v)) HudY = ClampInt(v, -1, 20000, -1);
            if (raw.TryGetValue("keepHistory", out v)) KeepHistory = v == "true";
            if (raw.TryGetValue("historyLimit", out v)) HistoryLimit = ClampInt(v, 10, 1000, 100);
            if (raw.TryGetValue("soundCues", out v)) SoundCues = v == "true";
            if (raw.TryGetValue("transcriptionEngine", out v)) TranscriptionEngine = SanitizeTranscriptionEngine(v);
        }

        public void Save()
        {
            try
            {
                string dir = Path.GetDirectoryName(FilePath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(FilePath, ToJson(), Encoding.UTF8);
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("Settings could not be saved: " + ex.GetType().Name);
            }
        }

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("{");
            Field(sb, "endpoint", Endpoint, true);
            Field(sb, "hotkey", Hotkey, true);
            Field(sb, "language", Language, true);
            Field(sb, "whisperLanguage", WhisperLanguage, true);
            Field(sb, "enhanceText", EnhanceText ? "true" : "false", false);
            Field(sb, "tone", Tone, true);
            Field(sb, "launchAtStartup", LaunchAtStartup ? "true" : "false", false);
            Field(sb, "minimizeToTray", MinimizeToTray ? "true" : "false", false);
            Field(sb, "showHud", ShowHud ? "true" : "false", false);
            Field(sb, "hudX", HudX.ToString(CultureInfo.InvariantCulture), false);
            Field(sb, "hudY", HudY.ToString(CultureInfo.InvariantCulture), false);
            Field(sb, "keepHistory", KeepHistory ? "true" : "false", false);
            Field(sb, "historyLimit", HistoryLimit.ToString(CultureInfo.InvariantCulture), false);
            Field(sb, "soundCues", SoundCues ? "true" : "false", false);
            Field(sb, "transcriptionEngine", TranscriptionEngine, true);
            sb.AppendLine("}");
            return sb.ToString();
        }

        private static void Field(StringBuilder sb, string key, string value, bool quote)
        {
            sb.Append("  \"").Append(key).Append("\": ");
            if (quote) sb.Append('"').Append(TalkityJson.Escape(value)).Append('"');
            else sb.Append(value);
            sb.AppendLine(",");
        }

        // ---- validation (internal so tests can reach it) ----

        internal static string SanitizeEndpoint(string value)
        {
            if (string.IsNullOrEmpty(value)) return DefaultEndpoint;
            string v = value.Trim();
            if (v.Length > 200) return DefaultEndpoint;
            bool ok = v.StartsWith("wss://") || v.StartsWith("ws://");
            if (!ok) return DefaultEndpoint;
            Uri parsed;
            if (!Uri.TryCreate(v, UriKind.Absolute, out parsed)) return DefaultEndpoint;
            return v;
        }

        internal static string SanitizeHotkey(string value)
        {
            if (string.IsNullOrEmpty(value)) return DefaultHotkey;
            string v = value.Trim().ToUpperInvariant();
            string[] allowed = { "F6", "F7", "F8", "F9", "F10", "CTRL+SHIFT+SPACE", "CTRL+SPACE" };
            for (int i = 0; i < allowed.Length; i++)
                if (allowed[i] == v) return v;
            return DefaultHotkey;
        }

        internal static string SanitizeLanguage(string value)
        {
            if (string.IsNullOrEmpty(value)) return "en-US";
            string v = value.Trim();
            if (v.Length < 2 || v.Length > 10) return "en-US";
            for (int i = 0; i < v.Length; i++)
            {
                char c = v[i];
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-';
                if (!ok) return "en-US";
            }
            return v;
        }

        /// <summary>
        /// Whisper accepts ISO-639-1 only ("en", "hi"), not region-qualified codes
        /// such as "en-IN". Anything invalid falls back to auto-detect rather than
        /// sending a value the API would reject.
        /// </summary>
        internal static string SanitizeWhisperLanguage(string value)
        {
            if (string.IsNullOrEmpty(value)) return "auto";
            string v = value.Trim().ToLowerInvariant();
            if (v == "auto") return v;
            if (v.Length != 2) return "auto";
            for (int i = 0; i < v.Length; i++)
            {
                if (v[i] < 'a' || v[i] > 'z') return "auto";
            }
            return v;
        }

        internal static string SanitizeTone(string value)
        {
            string[] allowed = { "clean", "concise", "professional", "prompt", "code" };
            for (int i = 0; i < allowed.Length; i++)
                if (allowed[i] == value) return value;
            return "clean";
        }

        internal static string SanitizeTranscriptionEngine(string value)
        {
            if (string.IsNullOrEmpty(value)) return DefaultTranscriptionEngine;
            string v = value.Trim().ToLowerInvariant();
            if (v == "system_speech" || v == "whisper") return v;
            return DefaultTranscriptionEngine;
        }

        private static int ClampInt(string value, int min, int max, int fallback)
        {
            int n;
            if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) return fallback;
            if (n < min || n > max) return fallback;
            return n;
        }

        /// <summary>Virtual-key code and modifier flags for the configured hotkey.</summary>
        public void ResolveHotkey(out uint modifiers, out uint virtualKey)
        {
            modifiers = 0x4000; // MOD_NOREPEAT
            switch (Hotkey)
            {
                case "F6": virtualKey = 0x75; break;
                case "F7": virtualKey = 0x76; break;
                case "F9": virtualKey = 0x78; break;
                case "F10": virtualKey = 0x79; break;
                case "CTRL+SHIFT+SPACE": modifiers |= 0x0002 | 0x0004; virtualKey = 0x20; break;
                case "CTRL+SPACE": modifiers |= 0x0002; virtualKey = 0x20; break;
                default: virtualKey = 0x77; break; // F8
            }
        }

        /// <summary>Register or remove the Run-at-startup entry. Best effort only.</summary>
        public void ApplyStartupRegistration()
        {
            try
            {
                Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser
                    .OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                if (key == null) return;
                if (LaunchAtStartup) key.SetValue("Talkity", "\"" + Application.ExecutablePath + "\" --background");
                else key.DeleteValue("Talkity", false);
                key.Close();
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("Startup registration failed: " + ex.GetType().Name);
            }
        }
    }

    /// <summary>
    /// Minimal JSON helpers shared by settings, history, and the protocol client.
    /// Handles flat objects plus one level of string escaping — enough for the
    /// schemas Talkity actually exchanges, with no third-party dependency.
    /// </summary>
    internal static class TalkityJson
    {
        public static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
        }

        public static string SerializeFlat(object obj)
        {
            StringBuilder sb = new StringBuilder("{");
            bool first = true;
            foreach (System.Reflection.PropertyInfo prop in obj.GetType().GetProperties())
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(Escape(prop.Name)).Append("\":");
                object val = prop.GetValue(obj, null);
                if (val == null) sb.Append("null");
                else if (val is bool) sb.Append((bool)val ? "true" : "false");
                else if (val is long) sb.Append(((long)val).ToString(CultureInfo.InvariantCulture));
                else if (val is int) sb.Append(((int)val).ToString(CultureInfo.InvariantCulture));
                else sb.Append('"').Append(Escape(val.ToString())).Append('"');
            }
            sb.Append('}');
            return sb.ToString();
        }

        public static Dictionary<string, string> ParseFlat(string json)
        {
            Dictionary<string, string> result = new Dictionary<string, string>();
            if (string.IsNullOrEmpty(json)) return result;
            string s = json.Trim();
            if (!s.StartsWith("{") || !s.EndsWith("}")) return result;
            s = s.Substring(1, s.Length - 2);

            int i = 0;
            while (i < s.Length)
            {
                while (i < s.Length && " \t\r\n,".IndexOf(s[i]) >= 0) i++;
                if (i >= s.Length || s[i] != '"') break;
                string key = ReadString(s, ref i);
                if (key == null) break;
                while (i < s.Length && s[i] != ':') i++;
                if (i >= s.Length) break;
                i++;
                while (i < s.Length && " \t".IndexOf(s[i]) >= 0) i++;
                if (i >= s.Length) break;

                if (s[i] == '"')
                {
                    result[key] = ReadString(s, ref i) ?? "";
                }
                else if (s[i] == '{' || s[i] == '[')
                {
                    char open = s[i];
                    char close = open == '{' ? '}' : ']';
                    int depth = 1;
                    i++;
                    while (i < s.Length && depth > 0)
                    {
                        if (s[i] == '"') { ReadString(s, ref i); continue; }
                        if (s[i] == open) depth++;
                        else if (s[i] == close) depth--;
                        i++;
                    }
                }
                else
                {
                    int start = i;
                    while (i < s.Length && s[i] != ',' && s[i] != '}') i++;
                    result[key] = s.Substring(start, i - start).Trim();
                }
            }
            return result;
        }

        public static string ReadString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return null;
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.Length && s[i] != '"')
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    i++;
                    switch (s[i])
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        default: sb.Append(s[i]); break;
                    }
                }
                else sb.Append(s[i]);
                i++;
            }
            if (i < s.Length) i++;
            return sb.ToString();
        }
    }
}
