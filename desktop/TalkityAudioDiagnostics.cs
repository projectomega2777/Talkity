using System;
using System.Globalization;

namespace TalkityDesktop
{
    /// <summary>
    /// Descriptive statistics for a captured PCM16 mono buffer.
    /// Used only for diagnostics: the samples sent to Whisper are never modified.
    /// </summary>
    internal sealed class AudioStats
    {
        public int SampleCount;
        public double DurationSeconds;
        public int Peak;
        public double PeakDbfs;
        public double RmsDbfs;
        public long ClippedSamples;
        public double ClippedPercent;
        public int LeadingSilenceMs;
        public int TrailingSilenceMs;
        public bool HasSpeech;
    }

    /// <summary>
    /// Pure analysis of 16-bit little-endian mono PCM. Kept separate from the
    /// recorder so it can be unit-tested with synthetic audio and so that a
    /// diagnostic problem can never alter the audio that is uploaded.
    /// </summary>
    internal static class TalkityAudioDiagnostics
    {
        // -40 dBFS. Speech peaks sit well above this; typical mic noise floors
        // sit well below it. A 10 ms block must reach it to count as speech so
        // that a single click or DC offset is not mistaken for the first word.
        public const int SpeechThreshold = 328;
        private const int BlockMs = 10;
        private const double SilenceFloorDbfs = -120.0;

        public static AudioStats AnalyzePcm16(byte[] pcm, int sampleRate)
        {
            AudioStats stats = new AudioStats();
            if (pcm == null || pcm.Length < 2 || sampleRate <= 0) return stats;

            int sampleCount = pcm.Length / 2;
            stats.SampleCount = sampleCount;
            stats.DurationSeconds = (double)sampleCount / sampleRate;

            long sumSquares = 0;
            int peak = 0;
            long clipped = 0;
            int blockSamples = Math.Max(1, sampleRate * BlockMs / 1000);
            int firstActiveBlock = -1;
            int lastActiveBlock = -1;
            int blockIndex = 0;
            int blockPeak = 0;
            int inBlock = 0;

            for (int i = 0; i < sampleCount; i++)
            {
                short sample = (short)(pcm[i * 2] | (pcm[i * 2 + 1] << 8));
                int amplitude = sample == short.MinValue ? 32768 : Math.Abs((int)sample);
                if (amplitude > peak) peak = amplitude;
                if (amplitude >= 32767) clipped++;
                sumSquares += (long)sample * sample;

                if (amplitude > blockPeak) blockPeak = amplitude;
                inBlock++;
                if (inBlock >= blockSamples)
                {
                    if (blockPeak >= SpeechThreshold)
                    {
                        if (firstActiveBlock < 0) firstActiveBlock = blockIndex;
                        lastActiveBlock = blockIndex;
                    }
                    blockIndex++;
                    inBlock = 0;
                    blockPeak = 0;
                }
            }

            // Score the final partial block too, otherwise the last few
            // milliseconds of a short clip would never count as speech.
            if (inBlock > 0 && blockPeak >= SpeechThreshold)
            {
                if (firstActiveBlock < 0) firstActiveBlock = blockIndex;
                lastActiveBlock = blockIndex;
                blockIndex++;
            }

            stats.Peak = peak;
            stats.PeakDbfs = ToDbfs(peak);
            stats.RmsDbfs = ToDbfs(sampleCount > 0 ? Math.Sqrt((double)sumSquares / sampleCount) : 0);
            stats.ClippedSamples = clipped;
            stats.ClippedPercent = sampleCount > 0 ? 100.0 * clipped / sampleCount : 0;
            stats.HasSpeech = peak >= SpeechThreshold;
            stats.LeadingSilenceMs = firstActiveBlock < 0
                ? (int)Math.Round(stats.DurationSeconds * 1000)
                : firstActiveBlock * BlockMs;
            stats.TrailingSilenceMs = lastActiveBlock < 0
                ? (int)Math.Round(stats.DurationSeconds * 1000)
                : Math.Max(0, (blockIndex - 1 - lastActiveBlock) * BlockMs);
            return stats;
        }

        public static double ToDbfs(double amplitude)
        {
            if (amplitude <= 0) return SilenceFloorDbfs;
            double db = 20.0 * Math.Log10(amplitude / 32768.0);
            return db < SilenceFloorDbfs ? SilenceFloorDbfs : db;
        }

        /// <summary>One-line, content-free summary safe for the diagnostic log.</summary>
        public static string Describe(AudioStats s)
        {
            if (s == null) return "no audio";
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0:0.00}s, peak {1:0.0} dBFS, RMS {2:0.0} dBFS, clipped {3:0.00}%, lead {4}ms, tail {5}ms",
                s.DurationSeconds, s.PeakDbfs, s.RmsDbfs, s.ClippedPercent,
                s.LeadingSilenceMs, s.TrailingSilenceMs);
        }
    }
}
