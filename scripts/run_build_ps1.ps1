$CSC = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$SPEECH = 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll'
Write-Output "=== BUILD TESTS ==="
$args_tests = @(
  '/main:TalkityDesktop.Tests.Program',
  '/out:TalkityTests.exe',
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  "/r:$SPEECH",
  '/unsafe',
  '..\apps\desktop\TalkityTests.cs',
  '..\apps\desktop\TalkityApp.cs',
  '..\apps\desktop\TalkityHud.cs',
  '..\apps\desktop\TalkityMain.cs',
  '..\apps\desktop\TalkitySettings.cs',
  '..\apps\desktop\TalkityPolish.cs',
  '..\apps\desktop\TalkityHistory.cs',
  '..\apps\desktop\TalkityLog.cs',
  '..\apps\desktop\TalkityWhisperRecorder.cs',
  '..\apps\desktop\TalkityWhisperClient.cs',
  '..\apps\desktop\TalkityAudioDiagnostics.cs',
  '..\apps\desktop\TalkityTextFormatter.cs'
)
$proc = Start-Process -FilePath $CSC -ArgumentList $args_tests -Wait -PassThru -NoNewWindow -RedirectStandardOutput 'csc_tests_out3.txt' -RedirectStandardError 'csc_tests_err3.txt'
Write-Output "Exit code: $($proc.ExitCode)"
