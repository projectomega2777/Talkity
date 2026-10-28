using System;
using System.Globalization;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TalkityDesktop
{
    /// <summary>
    /// Test-only acoustic harness. Records from the same WinMM recorder as
    /// Talkity and can play a reference WAV through either the default output
    /// (SoundPlayer) or a specific WinMM output device. It is not part of the
    /// application build.
    ///
    /// Usage:
    ///   MicValidationHarness.exe --list
    ///   MicValidationHarness.exe --play ref.wav --out captured.wav [--lead 4000] [--tail 2500] [--in-device -1] [--out-device -1]
    ///   MicValidationHarness.exe --record-only --out silence.wav --seconds 3 [--in-device 2]
    /// </summary>
    internal static class MicValidationHarness
    {
        private static int Main(string[] args)
        {
            string play = null;
            string output = null;
            int leadMs = 4000;
            int tailMs = 2500;
            int recordSeconds = 0;
            int inDevice = -1;
            int outDevice = -1;
            bool list = false;

            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--list": list = true; break;
                    case "--play": play = args[++i]; break;
                    case "--out": output = args[++i]; break;
                    case "--lead": leadMs = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                    case "--tail": tailMs = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                    case "--seconds": recordSeconds = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                    case "--record-only": recordSeconds = Math.Max(1, recordSeconds); break;
                    case "--in-device": inDevice = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                    case "--out-device": outDevice = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                    default:
                        Console.Error.WriteLine("Unknown argument: " + args[i]);
                        return 2;
                }
            }

            if (list)
            {
                WaveDeviceInfo.List();
                return 0;
            }

            if (string.IsNullOrEmpty(output))
            {
                Console.Error.WriteLine("--out is required");
                return 2;
            }
            if (string.IsNullOrEmpty(play) && recordSeconds <= 0)
            {
                Console.Error.WriteLine("--play or --record-only --seconds is required");
                return 2;
            }

            SoundPlayer soundPlayer = null;
            if (!string.IsNullOrEmpty(play) && outDevice < 0)
            {
                soundPlayer = new SoundPlayer(play);
                try { soundPlayer.Load(); }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("Could not load reference WAV: " + ex.Message);
                    return 5;
                }
            }

            Console.WriteLine("HARNESS start " + DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) +
                " in=" + inDevice + " out=" + outDevice);
            using (TalkityWhisperRecorder recorder = new TalkityWhisperRecorder(inDevice))
            {
                if (!recorder.StartRecording())
                {
                    Console.Error.WriteLine("Could not start recording");
                    return 3;
                }
                Console.WriteLine("HARNESS recording " + DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));

                byte[] wav = null;
                try
                {
                    if (!string.IsNullOrEmpty(play))
                    {
                        Thread.Sleep(leadMs);
                        Console.WriteLine("HARNESS play " + DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
                        if (soundPlayer != null) soundPlayer.PlaySync();
                        else WaveOutPlayer.Play(play, outDevice);
                        Console.WriteLine("HARNESS played " + DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
                        Thread.Sleep(tailMs);
                    }
                    else
                    {
                        Thread.Sleep(recordSeconds * 1000);
                    }
                }
                finally
                {
                    Console.WriteLine("HARNESS stop " + DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
                    wav = recorder.StopRecording();
                }

                if (wav == null || wav.Length <= 44)
                {
                    Console.Error.WriteLine("No audio captured");
                    return 4;
                }
                File.WriteAllBytes(output, wav);
                Console.WriteLine("WROTE " + output + " " + wav.Length + " bytes");
            }

            if (soundPlayer != null) soundPlayer.Dispose();
            return 0;
        }
    }

    internal static class WaveDeviceInfo
    {
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

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WAVEOUTCAPS
        {
            public ushort wMid;
            public ushort wPid;
            public uint vDriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szPname;
            public uint dwFormats;
            public ushort wChannels;
            public ushort wReserved1;
            public uint dwSupport;
        }

        [DllImport("winmm.dll")] private static extern int waveInGetNumDevs();
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern int waveInGetDevCaps(int uDeviceID, ref WAVEINCAPS pwic, int cbwic);
        [DllImport("winmm.dll")] private static extern int waveOutGetNumDevs();
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern int waveOutGetDevCaps(int uDeviceID, ref WAVEOUTCAPS pwoc, int cbwoc);

        public static void List()
        {
            int inputs = waveInGetNumDevs();
            Console.WriteLine("INPUTS=" + inputs);
            for (int i = 0; i < inputs; i++)
            {
                WAVEINCAPS caps = new WAVEINCAPS();
                int result = waveInGetDevCaps(i, ref caps, Marshal.SizeOf(typeof(WAVEINCAPS)));
                Console.WriteLine(i + " | result=" + result + " | " + caps.szPname + " | channels=" + caps.wChannels);
            }

            int outputs = waveOutGetNumDevs();
            Console.WriteLine("OUTPUTS=" + outputs);
            for (int i = 0; i < outputs; i++)
            {
                WAVEOUTCAPS caps = new WAVEOUTCAPS();
                int result = waveOutGetDevCaps(i, ref caps, Marshal.SizeOf(typeof(WAVEOUTCAPS)));
                Console.WriteLine(i + " | result=" + result + " | " + caps.szPname + " | channels=" + caps.wChannels);
            }
        }
    }

    internal static class WaveOutPlayer
    {
        private const int WAVE_FORMAT_PCM = 1;
        private const int CALLBACK_NULL = 0;
        private const int WHDR_DONE = 0x00000001;
        private const int WHDR_PREPARED = 0x00000002;
        private const int MMSYSERR_NOERROR = 0;

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

        [DllImport("winmm.dll")] private static extern int waveOutOpen(out IntPtr phwo, int uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
        [DllImport("winmm.dll")] private static extern int waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
        [DllImport("winmm.dll")] private static extern int waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
        [DllImport("winmm.dll")] private static extern int waveOutWrite(IntPtr hwo, IntPtr pwh, int cbwh);
        [DllImport("winmm.dll")] private static extern int waveOutReset(IntPtr hwo);
        [DllImport("winmm.dll")] private static extern int waveOutClose(IntPtr hwo);
        [DllImport("winmm.dll")] private static extern int waveOutSetVolume(IntPtr hwo, uint dwVolume);

        public static void Play(string path, int deviceId)
        {
            byte[] file = File.ReadAllBytes(path);
            WAVEFORMATEX format;
            byte[] pcm;
            ReadWav(file, out format, out pcm);

            IntPtr hwo = IntPtr.Zero;
            IntPtr dataPtr = IntPtr.Zero;
            IntPtr headerPtr = IntPtr.Zero;
            try
            {
                int result = waveOutOpen(out hwo, deviceId, ref format, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL);
                if (result != MMSYSERR_NOERROR) throw new InvalidOperationException("waveOutOpen failed: " + result);
                waveOutSetVolume(hwo, 0xFFFFFFFF);

                dataPtr = Marshal.AllocHGlobal(pcm.Length);
                Marshal.Copy(pcm, 0, dataPtr, pcm.Length);

                WAVEHDR header = new WAVEHDR();
                header.lpData = dataPtr;
                header.dwBufferLength = (uint)pcm.Length;
                header.dwFlags = 0;
                int headerSize = Marshal.SizeOf(typeof(WAVEHDR));
                headerPtr = Marshal.AllocHGlobal(headerSize);
                Marshal.StructureToPtr(header, headerPtr, false);

                result = waveOutPrepareHeader(hwo, headerPtr, headerSize);
                if (result != MMSYSERR_NOERROR) throw new InvalidOperationException("waveOutPrepareHeader failed: " + result);
                result = waveOutWrite(hwo, headerPtr, headerSize);
                if (result != MMSYSERR_NOERROR) throw new InvalidOperationException("waveOutWrite failed: " + result);

                double seconds = format.nAvgBytesPerSec > 0 ? (double)pcm.Length / format.nAvgBytesPerSec : 1.0;
                int timeoutMs = (int)(seconds * 1000) + 10000;
                int waited = 0;
                while (waited < timeoutMs)
                {
                    WAVEHDR current = (WAVEHDR)Marshal.PtrToStructure(headerPtr, typeof(WAVEHDR));
                    if ((current.dwFlags & WHDR_DONE) != 0) break;
                    Thread.Sleep(10);
                    waited += 10;
                }

                WAVEHDR final = (WAVEHDR)Marshal.PtrToStructure(headerPtr, typeof(WAVEHDR));
                if ((final.dwFlags & WHDR_PREPARED) != 0) waveOutUnprepareHeader(hwo, headerPtr, headerSize);
                if ((final.dwFlags & WHDR_DONE) == 0) waveOutReset(hwo);
            }
            finally
            {
                if (headerPtr != IntPtr.Zero) Marshal.FreeHGlobal(headerPtr);
                if (dataPtr != IntPtr.Zero) Marshal.FreeHGlobal(dataPtr);
                if (hwo != IntPtr.Zero) waveOutClose(hwo);
            }
        }

        private static void ReadWav(byte[] file, out WAVEFORMATEX format, out byte[] pcm)
        {
            if (file.Length < 44 || Encoding.ASCII.GetString(file, 0, 4) != "RIFF" || Encoding.ASCII.GetString(file, 8, 4) != "WAVE")
                throw new InvalidOperationException("Not a RIFF/WAVE file");

            format = new WAVEFORMATEX();
            pcm = null;
            int offset = 12;
            while (offset + 8 <= file.Length)
            {
                string id = Encoding.ASCII.GetString(file, offset, 4);
                int size = BitConverter.ToInt32(file, offset + 4);
                int body = offset + 8;
                if (id == "fmt " && size >= 16 && body + 16 <= file.Length)
                {
                    format.wFormatTag = BitConverter.ToUInt16(file, body);
                    format.nChannels = BitConverter.ToUInt16(file, body + 2);
                    format.nSamplesPerSec = BitConverter.ToUInt32(file, body + 4);
                    format.nAvgBytesPerSec = BitConverter.ToUInt32(file, body + 8);
                    format.nBlockAlign = BitConverter.ToUInt16(file, body + 12);
                    format.wBitsPerSample = BitConverter.ToUInt16(file, body + 14);
                    format.cbSize = 0;
                }
                else if (id == "data")
                {
                    int length = Math.Min(size, file.Length - body);
                    pcm = new byte[length];
                    Array.Copy(file, body, pcm, 0, length);
                    break;
                }
                offset = body + size + (size % 2);
            }

            if (pcm == null) throw new InvalidOperationException("No data chunk");
            if (format.wFormatTag != WAVE_FORMAT_PCM) throw new InvalidOperationException("Only PCM WAV is supported");
        }
    }
}
