using System;
using System.IO;
using System.Net;
using System.Text;

namespace TalkityDesktop
{
    /// <summary>
    /// Optional text enhancement through the Talkity backend's /api/polish endpoint.
    /// The backend applies its configured provider (Groq or OpenAI) when one is set
    /// up server-side, and a rule-based fallback otherwise. No API key is ever held
    /// or sent by this client.
    ///
    /// The raw transcript is always preserved: if the request fails, times out, or
    /// returns anything unusable, <see cref="Enhance"/> returns the original text
    /// with <c>enhanced == false</c> so the caller can still dictate.
    /// </summary>
    internal static class TalkityPolish
    {
        public const int TimeoutMs = 6000;

        public static PolishResult Enhance(string endpoint, string rawText, string tone)
        {
            PolishResult result = new PolishResult();
            result.Original = rawText ?? "";
            result.Text = result.Original;
            result.Enhanced = false;

            if (string.IsNullOrEmpty(rawText)) return result;

            string httpBase = ToHttpBase(endpoint);
            if (httpBase == null)
            {
                TalkityLog.Warn("Polish skipped: endpoint has no HTTP equivalent");
                return result;
            }

            try
            {
                string body = "{\"rawText\":\"" + TalkityJson.Escape(rawText) +
                              "\",\"tone\":\"" + TalkityJson.Escape(tone ?? "clean") + "\"}";
                byte[] bytes = Encoding.UTF8.GetBytes(body);

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(httpBase + "/api/polish");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = TimeoutMs;
                req.ReadWriteTimeout = TimeoutMs;
                req.ContentLength = bytes.Length;

                using (Stream s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    string polished = ExtractStringField(json, "formattedText");
                    if (!string.IsNullOrEmpty(polished))
                    {
                        result.Text = polished;
                        result.Enhanced = true;
                        result.Provider = ExtractStringField(json, "provider");
                    }
                    else
                    {
                        TalkityLog.Warn("Polish response had no formattedText; using raw transcript");
                    }
                }
            }
            catch (WebException ex)
            {
                TalkityLog.Warn("Polish request failed (" + ex.Status + "); using raw transcript");
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("Polish failed (" + ex.GetType().Name + "); using raw transcript");
            }
            return result;
        }

        /// <summary>Map a ws/wss endpoint to the HTTP base the REST API is served from.</summary>
        internal static string ToHttpBase(string wsEndpoint)
        {
            if (string.IsNullOrEmpty(wsEndpoint)) return null;
            string e = wsEndpoint.Trim().TrimEnd('/');
            if (e.StartsWith("wss://", StringComparison.OrdinalIgnoreCase)) return "https://" + e.Substring(6);
            if (e.StartsWith("ws://", StringComparison.OrdinalIgnoreCase)) return "http://" + e.Substring(5);
            // An endpoint may also be configured as an explicit HTTP(S) URL. Without
            // this, text enhancement was silently skipped ("endpoint has no HTTP
            // equivalent") while transcription kept working.
            if (e.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                e.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) return e;
            return null;
        }

        /// <summary>Read one JSON string field, honouring escape sequences.</summary>
        internal static string ExtractStringField(string json, string field)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string marker = "\"" + field + "\"";
            int at = json.IndexOf(marker);
            if (at < 0) return null;
            int i = at + marker.Length;
            while (i < json.Length && json[i] != ':') i++;
            if (i >= json.Length) return null;
            i++;
            while (i < json.Length && (json[i] == ' ' || json[i] == '\t')) i++;
            if (i >= json.Length || json[i] != '"') return null;
            return TalkityJson.ReadString(json, ref i);
        }
    }

    internal sealed class PolishResult
    {
        public string Original;
        public string Text;
        public bool Enhanced;
        public string Provider;
    }
}
