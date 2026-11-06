using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace TalkityDesktop
{
    /// <summary>One dictated entry kept locally. Text is stored only when history is enabled.</summary>
    internal sealed class HistoryEntry
    {
        public long Timestamp;
        public string Text;
        public bool Enhanced;
        public string TargetApp;
        public bool Inserted;
    }

    /// <summary>
    /// Bounded local dictation history in %APPDATA%\Talkity\history.json.
    /// Entries are stored newest first. The file is rewritten in full on each
    /// change; it stays small because the entry count is capped by settings.
    /// </summary>
    internal sealed class TalkityHistory
    {
        private readonly List<HistoryEntry> _entries = new List<HistoryEntry>();
        private readonly object _gate = new object();

        private static string FilePath
        {
            get
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Talkity");
                return Path.Combine(dir, "history.json");
            }
        }

        public void Load()
        {
            lock (_gate)
            {
                _entries.Clear();
                try
                {
                    if (!File.Exists(FilePath)) return;
                    string raw = File.ReadAllText(FilePath, Encoding.UTF8).Trim();
                    if (!raw.StartsWith("[")) return;
                    string[] parts = raw.Split(new string[] { "},{" }, StringSplitOptions.None);
                    for (int i = 0; i < parts.Length; i++)
                    {
                        Dictionary<string, string> f = TalkityJson.ParseFlat(NormalizeObject(parts[i]));
                        if (!f.ContainsKey("text")) continue;
                        HistoryEntry e = new HistoryEntry();
                        e.Text = f["text"];
                        long ts;
                        e.Timestamp = long.TryParse(Get(f, "timestamp"), NumberStyles.Integer,
                            CultureInfo.InvariantCulture, out ts) ? ts : 0;
                        e.Enhanced = Get(f, "enhanced") == "true";
                        e.Inserted = Get(f, "inserted") == "true";
                        e.TargetApp = Get(f, "targetApp");
                        _entries.Add(e);
                    }
                }
                catch (Exception ex)
                {
                    TalkityLog.Warn("History unreadable, starting empty: " + ex.GetType().Name);
                    _entries.Clear();
                }
            }
        }

        public void Add(HistoryEntry entry, int limit)
        {
            lock (_gate)
            {
                _entries.Insert(0, entry);
                while (_entries.Count > limit) _entries.RemoveAt(_entries.Count - 1);
                Persist();
            }
        }

        public List<HistoryEntry> Snapshot()
        {
            lock (_gate) { return new List<HistoryEntry>(_entries); }
        }

        public void Clear()
        {
            lock (_gate)
            {
                _entries.Clear();
                Persist();
            }
        }

        private void Persist()
        {
            try
            {
                string dir = Path.GetDirectoryName(FilePath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                StringBuilder sb = new StringBuilder();
                sb.Append('[');
                for (int i = 0; i < _entries.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    HistoryEntry e = _entries[i];
                    sb.Append('{');
                    sb.Append("\"timestamp\":").Append(e.Timestamp.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"text\":\"").Append(TalkityJson.Escape(e.Text ?? "")).Append('"');
                    sb.Append(",\"enhanced\":").Append(e.Enhanced ? "true" : "false");
                    sb.Append(",\"inserted\":").Append(e.Inserted ? "true" : "false");
                    sb.Append(",\"targetApp\":\"").Append(TalkityJson.Escape(e.TargetApp ?? "")).Append('"');
                    sb.Append('}');
                }
                sb.Append(']');
                File.WriteAllText(FilePath, sb.ToString(), Encoding.UTF8);
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("History could not be saved: " + ex.GetType().Name);
            }
        }

        private static string NormalizeObject(string part)
        {
            string s = part.Trim().TrimStart('[').TrimEnd(']');
            if (!s.StartsWith("{")) s = "{" + s;
            if (!s.EndsWith("}")) s = s + "}";
            return s;
        }

        private static string Get(Dictionary<string, string> d, string key)
        {
            string v;
            return d.TryGetValue(key, out v) ? v : "";
        }
    }
}
