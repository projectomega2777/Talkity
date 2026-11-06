using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TalkityDesktop
{
    /// <summary>
    /// Simple microphone recorder using WinMM waveIn APIs.
    /// Captures 16kHz, 16-bit, mono PCM into a MemoryStream.
    /// </summary>
    internal sealed class TalkityWhisperRecorder : IDisposable
    {
        // WinMM constants
        private const int WAVE_FORMAT_PCM = 1;
        // WAVE_MAPPER tells WinMM to open the user's default input device. Device 0
        // is merely the first enumerated device, which may be a webcam or virtual
        // cable instead of the microphone selected in Windows Sound settings.
        private const int WAVE_MAPPER = -1;
        private const int WHDR_DONE = 0x00000001;
        private const int WHDR_PREPARED = 0x00000002;
        private const int WIM_OPEN = 0x3BE;
        private const int WIM_CLOSE = 0x3BF;
        private const int WIM_DATA = 0x3C0;

        private const int MMSYSERR_NOERROR = 0;
        private const int MMSYSERR_INVALHANDLE = 8;

        private const int CALLBACK_FUNCTION = 0x00030000;

        // Audio format: 16kHz, 16-bit, mono
        private const int SampleRate = 16000;
        private const int BitsPerSample = 16;
        private const int Channels = 1;
        private const int BufferSize = 4096; // bytes per buffer
        private const int NumBuffers = 4;

        // WinMM structures
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct WAVEFORMATEX
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WAVEHDR
        {
            public IntPtr lpData;
            public uint dwBufferLength;
            public uint dwBytesRecorded;
            public IntPtr dwUser;
            public uint dwFlags;
            public uint dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WAVEINCAPS
        {
            public ushort wMid;
            public ushort wPid;
            public uint vDriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szPname;
            public uint dwFormats;
            public ushort wChannels;
            public ushort wReserved1;
        }

        // WaveIn callback delegate
        private delegate void WaveInProc(IntPtr hwi, int uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

        // WinMM imports
        [DllImport("winmm.dll", EntryPoint = "waveInGetNumDevs")]
        private static extern int waveInGetNumDevs();

        [DllImport("winmm.dll", EntryPoint = "waveInOpen")]
        private static extern int waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX pwfx, WaveInProc dwCallback, IntPtr dwInstance, int fdwOpen);

        [DllImport("winmm.dll", EntryPoint = "waveInPrepareHeader")]
        private static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

        [DllImport("winmm.dll", EntryPoint = "waveInUnprepareHeader")]
        private static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);

        [DllImport("winmm.dll", EntryPoint = "waveInAddBuffer")]
        private static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);

        [DllImport("winmm.dll", EntryPoint = "waveInStart")]
        private static extern int waveInStart(IntPtr hwi);

        [DllImport("winmm.dll", EntryPoint = "waveInStop")]
        private static extern int waveInStop(IntPtr hwi);

        [DllImport("winmm.dll", EntryPoint = "waveInReset")]
        private static extern int waveInReset(IntPtr hwi);

        [DllImport("winmm.dll", EntryPoint = "waveInClose")]
        private static extern int waveInClose(IntPtr hwi);

        [DllImport("winmm.dll", EntryPoint = "waveInGetErrorText")]
        private static extern int waveInGetErrorText(int mmrError, StringBuilder pszText, int cchText);

        [DllImport("winmm.dll", EntryPoint = "waveInGetID")]
        private static extern int waveInGetID(IntPtr hwi, out uint puDeviceID);

        [DllImport("winmm.dll", EntryPoint = "waveInGetDevCapsW", CharSet = CharSet.Unicode)]
        private static extern int waveInGetDevCaps(IntPtr uDeviceID, ref WAVEINCAPS pwic, int cbwic);

        // State
        private IntPtr _hWaveIn = IntPtr.Zero;
        // WAVEHDRs live in unmanaged memory. WinMM matches waveInAddBuffer against the
        // exact header address waveInPrepareHeader prepared, so the address must stay
        // stable and the header must be modified in place rather than copied.
        private IntPtr[] _headerPtrs = new IntPtr[NumBuffers];
        private int _headerSize;
        private readonly object _headerLock = new object();
        private readonly List<IntPtr> _buffers = new List<IntPtr>();
        private readonly MemoryStream _audioStream = new MemoryStream();
        private readonly object _streamLock = new object();
        private readonly WaveInProc _callback;
        private volatile bool _recording;
        private volatile bool _disposed;
        private bool _closing;
        private int _deviceId = -1;
        private readonly int _requestedDeviceId;
        private string _deviceName = "";
        private long _recordStartedTicks;

        public TalkityWhisperRecorder()
            : this(WAVE_MAPPER)
        {
        }

        // Test-only overload: open a specific WinMM input device instead of the
        // Windows default. The application always uses WAVE_MAPPER.
        internal TalkityWhisperRecorder(int deviceId)
        {
            _callback = WaveInCallback;
            _requestedDeviceId = deviceId;
        }

        /// <summary>
        /// Start recording from the default microphone device.
        /// Returns true if recording started successfully.
        /// </summary>
        public bool StartRecording()
        {
            if (_recording) return false;
            if (_disposed) return false;

            int numDevs = waveInGetNumDevs();
            if (numDevs <= 0)
            {
                TalkityLog.Warn("No microphone devices found");
                return false;
            }

            // WAVE_MAPPER follows the Windows default input device. A test-only
            // constructor can request a specific device ID instead.
            _deviceId = _requestedDeviceId;

            // Set up audio format
            WAVEFORMATEX format = new WAVEFORMATEX
            {
                wFormatTag = WAVE_FORMAT_PCM,
                nChannels = Channels,
                nSamplesPerSec = (uint)SampleRate,
                nAvgBytesPerSec = (uint)(SampleRate * Channels * BitsPerSample / 8),
                nBlockAlign = (ushort)(Channels * BitsPerSample / 8),
                wBitsPerSample = BitsPerSample,
                cbSize = 0
            };

            int result = waveInOpen(out _hWaveIn, _deviceId, ref format, _callback, IntPtr.Zero, CALLBACK_FUNCTION);
            if (result != MMSYSERR_NOERROR)
            {
                TalkityLog.Warn("waveInOpen failed: " + GetErrorText(result));
                _hWaveIn = IntPtr.Zero;
                return false;
            }

            LogSelectedDevice();

            // Allocate buffers and headers
            _buffers.Clear();
            _headerPtrs = new IntPtr[NumBuffers];
            _headerSize = Marshal.SizeOf(typeof(WAVEHDR));
            _closing = false;
            for (int i = 0; i < NumBuffers; i++)
            {
                IntPtr buffer = Marshal.AllocHGlobal(BufferSize);
                _buffers.Add(buffer);

                WAVEHDR header = new WAVEHDR
                {
                    lpData = buffer,
                    dwBufferLength = (uint)BufferSize,
                    dwBytesRecorded = 0,
                    dwUser = IntPtr.Zero,
                    dwFlags = 0,
                    dwLoops = 0,
                    lpNext = IntPtr.Zero,
                    reserved = IntPtr.Zero
                };

                IntPtr headerPtr = Marshal.AllocHGlobal(_headerSize);
                Marshal.StructureToPtr(header, headerPtr, false);
                _headerPtrs[i] = headerPtr;

                // Prepare header
                result = waveInPrepareHeader(_hWaveIn, headerPtr, _headerSize);
                if (result != MMSYSERR_NOERROR)
                {
                    TalkityLog.Warn("waveInPrepareHeader failed: " + GetErrorText(result));
                    CleanupBuffers();
                    waveInClose(_hWaveIn);
                    _hWaveIn = IntPtr.Zero;
                    return false;
                }

                // Add buffer to queue
                result = waveInAddBuffer(_hWaveIn, headerPtr, _headerSize);
                if (result != MMSYSERR_NOERROR)
                {
                    TalkityLog.Warn("waveInAddBuffer failed: " + GetErrorText(result));
                    CleanupBuffers();
                    waveInClose(_hWaveIn);
                    _hWaveIn = IntPtr.Zero;
                    return false;
                }
            }

            // Start recording
            _audioStream.SetLength(0);
            _recording = true;
            _recordStartedTicks = Stopwatch.GetTimestamp();
            result = waveInStart(_hWaveIn);
            if (result != MMSYSERR_NOERROR)
            {
                TalkityLog.Warn("waveInStart failed: " + GetErrorText(result));
                _recording = false;
                waveInReset(_hWaveIn);
                CleanupBuffers();
                waveInClose(_hWaveIn);
                _hWaveIn = IntPtr.Zero;
                return false;
            }

            TalkityLog.Info("Whisper recorder started (16kHz, 16-bit, mono, Windows default input device)");
            return true;
        }

        /// <summary>
        /// Log the device WinMM actually opened. With WAVE_MAPPER this is the
        /// device currently selected in Windows Sound settings; logging its name
        /// makes a wrong-microphone capture visible without recording any audio.
        /// </summary>
        private void LogSelectedDevice()
        {
            try
            {
                uint id;
                int result = waveInGetID(_hWaveIn, out id);
                if (result != MMSYSERR_NOERROR)
                {
                    TalkityLog.Info("Whisper recorder using Windows default input device");
                    return;
                }

                WAVEINCAPS caps = new WAVEINCAPS();
                result = waveInGetDevCaps((IntPtr)(int)id, ref caps, Marshal.SizeOf(typeof(WAVEINCAPS)));
                if (result == MMSYSERR_NOERROR && !string.IsNullOrEmpty(caps.szPname))
                {
                    _deviceName = caps.szPname;
                    TalkityLog.Info("Whisper recorder input device: " + _deviceName + " (id " + id + ")");
                }
                else
                {
                    TalkityLog.Info("Whisper recorder input device id " + id + " (name unavailable)");
                }
            }
            catch (Exception ex)
            {
                TalkityLog.Warn("Could not read microphone device name: " + ex.GetType().Name);
            }
        }

        /// <summary>
        /// Stop recording and return the captured audio as a WAV byte array.
        /// Returns null if recording failed or was not started.
        /// </summary>
        public byte[] StopRecording()
        {
            if (!_recording || _hWaveIn == IntPtr.Zero)
            {
                return null;
            }

            _recording = false;

            // Stop and reset
            int result = waveInStop(_hWaveIn);
            if (result != MMSYSERR_NOERROR)
            {
                TalkityLog.Warn("waveInStop failed: " + GetErrorText(result));
            }

            result = waveInReset(_hWaveIn);
            if (result != MMSYSERR_NOERROR)
            {
                TalkityLog.Warn("waveInReset failed: " + GetErrorText(result));
            }

            // Wait a bit for any pending callbacks to complete. waveInReset returns
            // every queued buffer, so without this pause the tail of the recording
            // would be freed before its WIM_DATA callback had copied the samples.
            Thread.Sleep(100);

            // Unprepare and free headers/buffers under the callback lock. _closing makes
            // any callback that acquires the lock afterwards return without touching
            // memory that is about to be released.
            lock (_headerLock)
            {
                _closing = true;
                CleanupBuffers();
            }

            // Close device
            result = waveInClose(_hWaveIn);
            if (result != MMSYSERR_NOERROR)
            {
                TalkityLog.Warn("waveInClose failed: " + GetErrorText(result));
            }
            _hWaveIn = IntPtr.Zero;

            // Build WAV file
            byte[] rawData;
            lock (_streamLock)
            {
                rawData = _audioStream.ToArray();
            }

            if (rawData.Length < 500)
            {
                TalkityLog.Warn("Recording too short (" + rawData.Length + " bytes), discarding");
                return null;
            }

            byte[] wavData = BuildWav(rawData, SampleRate, BitsPerSample, Channels);
            LogAudioDiagnostics(rawData);
            TalkityLog.Info("Whisper recorder stopped, captured " + wavData.Length + " bytes");
            return wavData;
        }

        /// <summary>
        /// Log content-free audio statistics so real-microphone problems (wrong
        /// input device, muted mic, clipping, a clipped first word) are visible
        /// in the log. This never changes the samples that are uploaded.
        /// </summary>
        private void LogAudioDiagnostics(byte[] pcmData)
        {
            AudioStats stats = TalkityAudioDiagnostics.AnalyzePcm16(pcmData, SampleRate);
            double wallSeconds = 0;
            if (_recordStartedTicks != 0)
            {
                wallSeconds = (Stopwatch.GetTimestamp() - _recordStartedTicks) / (double)Stopwatch.Frequency;
            }

            TalkityLog.Info("Whisper audio: " + TalkityAudioDiagnostics.Describe(stats) +
                (wallSeconds > 0 ? ", capture window " + wallSeconds.ToString("0.00", CultureInfo.InvariantCulture) + "s" : ""));

            if (!stats.HasSpeech)
            {
                TalkityLog.Warn("Whisper audio has no speech above -40 dBFS; check the selected microphone and input level");
                return;
            }

            if (stats.PeakDbfs < -35.0)
            {
                TalkityLog.Warn("Microphone level is low (peak " + stats.PeakDbfs.ToString("0.0", CultureInfo.InvariantCulture) +
                    " dBFS); raise the Windows input level or select the correct microphone");
            }
            if (stats.ClippedPercent > 0.1)
            {
                TalkityLog.Warn("Microphone audio is clipping (" + stats.ClippedPercent.ToString("0.00", CultureInfo.InvariantCulture) +
                    "% of samples); lower the Windows input level");
            }
            if (stats.LeadingSilenceMs > 700)
            {
                TalkityLog.Warn("Speech started " + stats.LeadingSilenceMs + " ms after capture began; the first word may be clipped");
            }
            if (wallSeconds > 0 && wallSeconds - stats.DurationSeconds > 0.35)
            {
                TalkityLog.Warn("Audio is " + (int)Math.Round((wallSeconds - stats.DurationSeconds) * 1000) +
                    " ms shorter than the capture window; the tail may have been lost");
            }
        }

        private void WaveInCallback(IntPtr hwi, int uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2)
        {
            if (uMsg != WIM_DATA) return;
            if (_disposed || hwi != _hWaveIn || dwParam1 == IntPtr.Zero) return;

            lock (_headerLock)
            {
                if (_closing || _disposed) return;

                // dwParam1 points at the live WAVEHDR. It is read and written back at the
                // same address: copying the struct into a local and re-queueing the copy
                // drops WHDR_PREPARED, which is exactly what made every re-queue fail with
                // "The wave header was not prepared". With all four buffers rejected after
                // their first fill, each recording was capped at 4 x 4096 bytes (0.512 s),
                // which is why "captured 16428 bytes" never changed.
                WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(dwParam1, typeof(WAVEHDR));

                if (header.dwBytesRecorded > 0 && header.lpData != IntPtr.Zero)
                {
                    byte[] data = new byte[header.dwBytesRecorded];
                    Marshal.Copy(header.lpData, data, 0, data.Length);

                    lock (_streamLock)
                    {
                        _audioStream.Write(data, 0, data.Length);
                    }
                }

                // Keep collecting the tail of the recording after stop, but stop
                // re-queueing once the caller has asked to finish.
                if (!_recording) return;

                // Clear only the completion flag; WHDR_PREPARED must survive so the
                // header remains valid for the next waveInAddBuffer.
                header.dwBytesRecorded = 0;
                header.dwFlags &= ~(uint)WHDR_DONE;
                Marshal.StructureToPtr(header, dwParam1, false);

                int result = waveInAddBuffer(_hWaveIn, dwParam1, _headerSize);
                if (result != MMSYSERR_NOERROR)
                {
                    TalkityLog.Warn("waveInAddBuffer in callback failed: " + GetErrorText(result));
                }
            }
        }

        private void CleanupBuffers()
        {
            // Unprepare before freeing: WinMM owns resources tied to a prepared header.
            for (int i = 0; i < _headerPtrs.Length; i++)
            {
                IntPtr headerPtr = _headerPtrs[i];
                if (headerPtr == IntPtr.Zero) continue;
                if (_hWaveIn != IntPtr.Zero)
                {
                    try
                    {
                        WAVEHDR header = (WAVEHDR)Marshal.PtrToStructure(headerPtr, typeof(WAVEHDR));
                        if ((header.dwFlags & WHDR_PREPARED) != 0)
                            waveInUnprepareHeader(_hWaveIn, headerPtr, _headerSize);
                    }
                    catch (Exception ex)
                    {
                        TalkityLog.Warn("waveInUnprepareHeader failed: " + ex.GetType().Name);
                    }
                }
                Marshal.FreeHGlobal(headerPtr);
                _headerPtrs[i] = IntPtr.Zero;
            }

            foreach (IntPtr buffer in _buffers)
            {
                if (buffer != IntPtr.Zero)
                    Marshal.FreeHGlobal(buffer);
            }
            _buffers.Clear();
        }

        private static string GetErrorText(int errorCode)
        {
            StringBuilder sb = new StringBuilder(256);
            waveInGetErrorText(errorCode, sb, sb.Capacity);
            return sb.ToString();
        }

        internal static byte[] BuildWav(byte[] pcmData, int sampleRate, int bitsPerSample, int channels)
        {
            using (MemoryStream ms = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(ms))
            {
                int byteRate = sampleRate * channels * bitsPerSample / 8;
                int blockAlign = channels * bitsPerSample / 8;
                int dataSize = pcmData.Length;
                // RIFF chunks are word-aligned: an odd data chunk needs one pad byte.
                int padSize = dataSize % 2;
                int fileSize = 36 + dataSize + padSize;

                // RIFF header
                writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
                writer.Write(fileSize);
                writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));

                // fmt chunk
                writer.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
                writer.Write(16); // chunk size
                writer.Write((short)WAVE_FORMAT_PCM); // audio format
                writer.Write((short)channels);
                writer.Write(sampleRate);
                writer.Write(byteRate);
                writer.Write((short)blockAlign);
                writer.Write((short)bitsPerSample);

                // data chunk
                writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));
                writer.Write(dataSize);
                writer.Write(pcmData);
                if (padSize != 0) writer.Write((byte)0);

                return ms.ToArray();
            }
        }

        public void Dispose()
        {
            if (_disposed) return;

            try { if (_recording) StopRecording(); }
            catch (Exception ex) { TalkityLog.Warn("Recorder stop on dispose failed: " + ex.GetType().Name); }

            // Guarantee the device and every unmanaged block are released even if
            // StartRecording threw part way through.
            lock (_headerLock)
            {
                _closing = true;
                CleanupBuffers();
                if (_hWaveIn != IntPtr.Zero)
                {
                    waveInClose(_hWaveIn);
                    _hWaveIn = IntPtr.Zero;
                }
            }
            _disposed = true;
        }
    }
}