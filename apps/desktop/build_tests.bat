@echo off
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set SPEECH=C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll
%CSC% /main:TalkityDesktop.Tests.Program /out:TalkityTests.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:"%SPEECH%" /unsafe ^
  TalkityTests.cs AssemblyInfo.cs TalkityApp.cs TalkityHud.cs TalkityMain.cs ^
  TalkitySettings.cs TalkityPolish.cs TalkityHistory.cs TalkityLog.cs ^
  TalkityWhisperRecorder.cs TalkityWhisperClient.cs TalkityAudioDiagnostics.cs TalkityTextFormatter.cs
echo Build exited with code %ERRORLEVEL%
