using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace TalkityDesktop
{
    /// <summary>
    /// Client for Talkity's server-side /api/transcribe endpoint (Whisper).
    /// Sends complete WAV recordings, receives JSON transcripts.
    /// Does not hold or send provider API keys.
    /// </summary>
    internal sealed class TalkityWhisperClient : IDisposable
    {
        public const int TimeoutMs = 15000; // slightly longer than server processing
        private readonly string _endpoint; // http/https base URL
        private readonly string _clientId;
        private readonly string _language; // explicit Whisper language, or null for auto-detect

        private bool _disposed;

        public TalkityWhisperClient(string endpoint, string clientId)
            : this(endpoint, clientId, null)
        {
        }

        public TalkityWhisperClient(string endpoint, string clientId, string language)
        {
            // Convert ws:// or wss:// endpoint to http:// or https:// for API calls
            _endpoint = ToHttpBase(endpoint ?? "wss://talkity-qifh.onrender.com/");
            _clientId = clientId ?? "desktop-unknown";
            _language = NormalizeLanguage(language);
        }

        /// <summary>
        /// Whisper expects ISO-639-1 (two lowercase letters). "auto" and empty mean
        /// auto-detect, which is the right default for Hindi/Hinglish dictation.
        /// The app's System.Speech locale (en-US, en-IN) is deliberately not sent:
        /// Whisper does not accept region-qualified codes, and forcing English would
        /// bias the model against mixed-language speech.
        /// </summary>
        internal static string NormalizeLanguage(string language)
        {
            if (string.IsNullOrEmpty(language)) return null;
            string value = language.Trim().ToLowerInvariant();
            if (value == "auto" || value.Length != 2) return null;
            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] < 'a' || value[i] > 'z') return null;
            }
            return value;
        }

        /// <summary>
        /// Send a complete WAV recording to the server and return the parsed result.
        /// Returns null if the request fails, times out, or the server returns an error.
        /// </summary>
        public TranscriptionResult Transcribe(byte[] wavData)
        {
            if (_disposed) return null;
            if (wavData == null || wavData.Length < 500)
            {
                TalkityLog.Warn("WhisperClient: audio too short (" + (wavData == null ? 0 : wavData.Length) + " bytes)");
                return null;
            }

            if (wavData.Length > 10 * 1024 * 1024)
            {
                TalkityLog.Warn("WhisperClient: audio exceeds 10MB limit (" + wavData.Length + "), truncating not supported in PoC");
                return null;
            }

            string url = _endpoint.TrimEnd('/') + "/api/transcribe";
            TalkityLog.Info("WhisperClient: Posting to " + url + " (" + wavData.Length + " bytes)");
            long startMs = System.Diagnostics.Stopwatch.GetTimestamp();

            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "audio/wav";
                req.Timeout = TimeoutMs;
                req.ReadWriteTimeout = TimeoutMs;
                req.ContentLength = wavData.Length;
                if (_language != null) req.Headers["x-language"] = _language;

                // Do not expose any provider keys from the client.
                // The server selects the provider from its own environment.

                using (Stream s = req.GetRequestStream())
                {
                    s.Write(wavData, 0, wavData.Length);
                }

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    long durationMs = (System.Diagnostics.Stopwatch.GetTimestamp() - startMs) * 1000 / System.Diagnostics.Stopwatch.Frequency;
                    TalkityLog.Info("WhisperClient response: HTTP " + (int)resp.StatusCode + " in " + durationMs + "ms, length=" + json.Length);

                    TranscriptionResult result = new TranscriptionResult();
                    result.RawText = ExtractStringField(json, "text");
                    result.FormattedText = ExtractStringField(json, "formattedText") ?? result.RawText;
                    result.NormalizedText = ExtractStringField(json, "normalizedText");
                    result.DetectedLanguage = ExtractStringField(json, "language");
                    result.Provider = ExtractStringField(json, "provider") ?? "unknown";
                    result.Success = !string.IsNullOrEmpty(result.RawText);
                    result.ResponseLength = json.Length;
                    if (!string.IsNullOrEmpty(result.DetectedLanguage))
                        TalkityLog.Info("WhisperClient detected language: " + result.DetectedLanguage);

                    if (!result.Success)
                    {
                        result.ErrorMessage = ExtractStringField(json, "error") ?? "Server returned empty transcript.";
                        TalkityLog.Warn("WhisperClient: server returned HTTP " + (int)resp.StatusCode + ", error=" + result.ErrorMessage);
                        return result;
                    }

                    return result;
                }
            }
            catch (WebException ex)
            {
                int statusCode = 0;
                string statusDescription = "unknown";
                string body = "";
                HttpWebResponse httpResp = ex.Response as HttpWebResponse;
                if (httpResp != null)
                {
                    statusCode = (int)httpResp.StatusCode;
                    statusDescription = httpResp.StatusDescription;
                    try
                    {
                        using (StreamReader r = new StreamReader(httpResp.GetResponseStream(), Encoding.UTF8))
                        {
                            body = r.ReadToEnd();
                        }
                    }
                    catch { }
                }

                string errorDetail = ExtractStringField(body, "error");
                string diagnostic = "WhisperClient WebException: Status=" + ex.Status + ", HTTP=" + statusCode + " " + statusDescription;
                if (ex.Status == WebExceptionStatus.ConnectFailure) diagnostic += " (Connection Refused)";
                else if (ex.Status == WebExceptionStatus.NameResolutionFailure) diagnostic += " (DNS Error)";
                else if (ex.Status == WebExceptionStatus.TrustFailure) diagnostic += " (TLS/Certificate Error)";
                else if (ex.Status == WebExceptionStatus.Timeout) diagnostic += " (Timeout)";
                else if (statusCode == 404) diagnostic += " (Not Found)";
                else if (statusCode == 401 || statusCode == 403) diagnostic += " (Unauthorized/Forbidden)";
                else if (statusCode == 429) diagnostic += " (Rate Limited)";
                else if (statusCode >= 500) diagnostic += " (Server Error)";

                TalkityLog.Warn(diagnostic + " - body=" + SanitizeBody(body));

                TranscriptionResult errResult = new TranscriptionResult();
                errResult.Success = false;
                errResult.ErrorMessage = !string.IsNullOrEmpty(errorDetail) ? errorDetail : (statusCode > 0 ? "HTTP " + statusCode + ": " + (statusDescription ?? "Error") : ex.Status.ToString());
                return errResult;
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("WhisperClient exception: " + ex.GetType().Name + " - " + ex.Message);
                TranscriptionResult errResult = new TranscriptionResult();
                errResult.Success = false;
                errResult.ErrorMessage = ex.Message;
                return errResult;
            }
        }

        /// <summary>
        /// Convert ws:// or wss:// endpoint to http:// or https:// for REST calls.
        /// Matches the logic in TalkityPolish.ToHttpBase.
        /// </summary>
        private static string ToHttpBase(string endpoint)
        {
            if (string.IsNullOrEmpty(endpoint)) return "https://talkity-qifh.onrender.com/";
            string trimmed = endpoint.Trim();
            if (trimmed.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
                return "https://" + trimmed.Substring(6);
            if (trimmed.StartsWith("ws://", StringComparison.OrdinalIgnoreCase))
                return "http://" + trimmed.Substring(5);
            if (trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                return trimmed;
            // If it doesn't look like a URL at all, fall back to production endpoint
            return "https://talkity-qifh.onrender.com/";
        }

        private static string SanitizeBody(string body)
        {
            if (string.IsNullOrEmpty(body)) return "";
            string sanitized = body.Replace("\r", "").Replace("\n", " ");
            if (sanitized.Length > 200) return sanitized.Substring(0, 200) + "...";
            return sanitized;
        }

        internal static string ExtractStringField(string json, string field)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string search = "\"" + field + "\":";
            int idx = json.IndexOf(search);
            if (idx < 0) return null;
            int start = idx + search.Length;
            // Skip whitespace
            while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
            if (start >= json.Length) return null;
            if (json[start] == '"')
            {
                start++;
                StringBuilder sb = new StringBuilder();
                int i = start;
                while (i < json.Length)
                {
                    if (json[i] == '\\' && i + 1 < json.Length)
                    {
                        char next = json[i + 1];
                        if (next == 'n') sb.Append('\n');
                        else if (next == 'r') sb.Append('\r');
                        else if (next == 't') sb.Append('\t');
                        else if (next == '"') sb.Append('"');
                        else if (next == '\\') sb.Append('\\');
                        else sb.Append(next);
                        i += 2;
                    }
                    else if (json[i] == '"')
                    {
                        break;
                    }
                    else
                    {
                        sb.Append(json[i]);
                        i++;
                    }
                }
                return sb.ToString();
            }
            else
            {
                // Non-string value (number, bool, null) - just read until delimiter
                int end = start;
                while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != ']') end++;
                string value = json.Substring(start, end - start).Trim();
                return value == "null" ? null : value;
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
        }
    }

    /// <summary>
    /// Result of a transcription request from the Whisper endpoint.
    /// </summary>
    internal class TranscriptionResult
    {
        public string RawText;
        public string FormattedText;
        /// <summary>
        /// Conservative, meaning-preserving cleanup returned by newer servers
        /// (dictionary spelling plus punctuation/capitalization, never filler
        /// deletion). Older servers omit it; the desktop then formats locally.
        /// </summary>
        public string NormalizedText;
        /// <summary>Language reported by Whisper (auto-detect result), if provided.</summary>
        public string DetectedLanguage;
        public string Provider;
        public bool Success;
        public int ResponseLength;
        /// <summary>Human-readable failure reason surfaced from the server or network layer.</summary>
        public string ErrorMessage;
    }
}