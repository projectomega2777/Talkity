using System;
using System.IO;
using System.Text;

namespace TalkityDesktop
{
    /// <summary>
    /// Append-only diagnostic log. Writes to %APPDATA%\Talkity\talkity.log and
    /// mirrors to the console. Never records dictated text, clipboard contents,
    /// or secrets — callers must pass only status information.
    /// </summary>
    internal static class TalkityLog
    {
        private const long MaxBytes = 512 * 1024;
        private static readonly object Gate = new object();
        private static string _path;

        public static void Info(string message)  { Write("INFO ", message); }
        public static void Warn(string message)  { Write("WARN ", message); }
        public static void Error(string message) { Write("ERROR", message); }

        private static void Write(string level, string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + level + " " + message;
            try { Console.WriteLine(line); } catch { }

            lock (Gate)
            {
                try
                {
                    if (_path == null)
                    {
                        string dir = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Talkity");
                        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                        _path = Path.Combine(dir, "talkity.log");
                    }
                    FileInfo info = new FileInfo(_path);
                    if (info.Exists && info.Length > MaxBytes)
                    {
                        string rotated = _path + ".1";
                        if (File.Exists(rotated)) File.Delete(rotated);
                        File.Move(_path, rotated);
                    }
                    File.AppendAllText(_path, line + Environment.NewLine, Encoding.UTF8);
                }
                catch { /* logging must never throw into the caller */ }
            }
        }
    }
}
