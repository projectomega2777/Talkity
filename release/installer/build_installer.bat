@echo off
rem ---------------------------------------------------------------------------
rem  Builds release\output\TalkitySetup.exe with Inno Setup 6.
rem
rem  Prerequisite: Talkity.exe must already be built from the current source.
rem      build_app.bat
rem
rem  The compiler is looked up in this order:
rem      1. %LOCALAPPDATA%\Programs\InnoSetup6\ISCC.exe
rem      2. %ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
rem      3. %ProgramFiles%\Inno Setup 6\ISCC.exe
rem      4. ISCC.EXE on PATH
rem ---------------------------------------------------------------------------
setlocal

set "ISCC=%LOCALAPPDATA%\Programs\InnoSetup6\ISCC.exe"
if exist "%ISCC%" goto :found
set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" goto :found
set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" goto :found
for %%I in (ISCC.EXE) do set "ISCC=%%~$PATH:I"
if exist "%ISCC%" goto :found

echo ERROR: ISCC.exe not found. Install Inno Setup 6 (see release\installer\README.md).
exit /b 1

:found
if not exist "%~dp0..\..\Talkity.exe" (
  echo ERROR: Talkity.exe not found. Run build_app.bat from the repository root first.
  exit /b 1
)

echo Using compiler: %ISCC%
"%ISCC%" "%~dp0Talkity.iss"
echo Installer build exited with code %ERRORLEVEL%
exit /b %ERRORLEVEL%
