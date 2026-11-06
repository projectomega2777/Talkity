using System;
using System.Text;
using System.Text.RegularExpressions;

namespace TalkityDesktop
{
    /// <summary>
    /// Conservative punctuation/capitalization cleanup for a Whisper transcript.
    ///
    /// This intentionally does NOT remove filler words, rewrite phrasing, or change
    /// word order. Whisper Large V3 already emits punctuation and sentence casing;
    /// the only measured regression in the live pipeline came from the server's
    /// "clean" pass deleting words such as "Um" and "you know". Everything here is
    /// whitespace, casing, or terminal punctuation, and the word sequence is
    /// preserved exactly.
    /// </summary>
    internal static class TalkityTextFormatter
    {
        private static readonly Regex MultiSpace = new Regex(@"[ \t]+", RegexOptions.Compiled);
        private static readonly Regex ManyNewlines = new Regex(@"\n{3,}", RegexOptions.Compiled);
        private static readonly Regex SpaceBeforePunctuation = new Regex(@"[ \t]+([,.!?;:])", RegexOptions.Compiled);
        private static readonly Regex MissingSpaceAfterPunctuation = new Regex(@"([,;:])([A-Za-z])", RegexOptions.Compiled);
        private static readonly Regex LineStart = new Regex(@"(^|\n)([^\p{L}\p{N}\n]*)([a-z])", RegexOptions.Compiled);
        private static readonly Regex StandaloneI = new Regex(@"(^|[^A-Za-z])i(?![A-Za-z]|\.[A-Za-z])", RegexOptions.Compiled);

        public static string Format(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";

            string result = text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
            if (result.Length == 0) return "";

            // Normalize horizontal whitespace line by line so paragraph breaks survive.
            string[] lines = result.Split('\n');
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < lines.Length; i++)
            {
                if (i > 0) sb.Append('\n');
                sb.Append(MultiSpace.Replace(lines[i], " ").Trim());
            }
            result = ManyNewlines.Replace(sb.ToString(), "\n\n").Trim();
            if (result.Length == 0) return "";

            // "word ,word" is a common Whisper spacing artifact. Only spaces move.
            result = SpaceBeforePunctuation.Replace(result, "$1");
            result = MissingSpaceAfterPunctuation.Replace(result, "$1 $2");

            // Capitalize the first letter of the transcript and of each paragraph.
            result = LineStart.Replace(result, delegate(Match m)
            {
                return m.Groups[1].Value + m.Groups[2].Value + char.ToUpperInvariant(m.Groups[3].Value[0]);
            });

            // Capitalize the pronoun "i" but leave "i.e." and words containing i alone.
            result = StandaloneI.Replace(result, delegate(Match m)
            {
                return m.Groups[1].Value + "I";
            });

            // Add a terminal period only when the text ends in a word character.
            // Closing quotes, brackets, and existing punctuation are left untouched.
            char last = result[result.Length - 1];
            if (char.IsLetterOrDigit(last)) result += ".";
            return result;
        }
    }
}
