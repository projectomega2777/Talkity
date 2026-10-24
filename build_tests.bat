@echo off
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /out:TalkityTests.exe ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll ^
  desktop\TalkityTests.cs
