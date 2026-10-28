# Talkity Desktop — Release Build Instructions

## Requirements

- Windows 10/11 with .NET Framework 4.5 or later installed
- Visual C# compiler (v4.0.30319 or newer) — included with .NET Framework
- System.Speech.dll (GAC assembly) — part of .NET Framework

No external NuGet packages, runtime installers, or third-party libraries are required.

## Clean Build (Release)

From the repository root (Windows Command Prompt or PowerShell):

```cmd
build_app.bat
```

This produces `Talkity.exe` (release binary) in the repository root.

Result: `Build exited with code 0`

## Test Suite

```cmd
build_tests.bat
TalkityTests.exe
```

Expected result: `Results: 149 passed, 0 failed`

## Build Artifacts

| File | Size | Purpose |
|------|------|---------|
| `Talkity.exe` | ~64 KB | Application executable |
| `TalkityTests.exe` | ~32 KB | Automated test executable |

Both are standalone .NET executables (no installer required to run, but recommended for distribution).

## Installation (Manual — No Installer Required)

Because the application requires no administrator privileges and writes user settings to `%APPDATA%\Talkity\`, it can be distributed as a portable executable:

1. Copy `Talkity.exe` to any folder (e.g., `C:\Program Files\Talkity\` or user folder).
2. Launch `Talkity.exe`.
3. Settings (`settings.json`), history (`history.json`), and logs (`talkity.log`) are written to the user's `%APPDATA%\Talkity\` directory, not the install folder.
4. To remove: delete the executable folder and optionally delete `%APPDATA%\Talkity\` to erase user data.

## Per-User Installation (No Admin)

Recommended for a clean install experience:

```cmd
mkdir "%LOCALAPPDATA%\Talkity"
copy Talkity.exe "%LOCALAPPDATA%\Talkity\"
```

Shortcut (manual):

```cmd
echo Set WshShell = CreateObject("WScript.Shell") > %TEMP%\talkity_shortcut.vbs
echo WshShell.CreateShortcut("%APPDATA%\Microsoft\Windows\Start Menu\Programs\Talkity.lnk").TargetPath = "%LOCALAPPDATA%\Talkity\Talkity.exe" >> %TEMP%\talkity_shortcut.vbs
wscript %TEMP%\talkity_shortcut.vbs
```

## Settings Persistence (Upgrade / Uninstall)

- **Upgrade / Reinstall**: Existing `%APPDATA%\Talkity\settings.json`, `history.json`, and `talkity.log` are preserved automatically because they live outside the installation folder.
- **Uninstall (complete)**: Delete `%APPDATA%\Talkity\` manually. The executable folder can then be removed safely.
- **Uninstall (quick)**: Only delete the executable folder; user preferences remain for next install.

## Runtime Dependencies (Documented)

- .NET Framework 4.5+ (standard on Windows 10/11)
- `System.Speech.dll` — GAC assembly (included with .NET Framework)
- `System.Windows.Forms.dll` — GAC assembly
- `System.Drawing.dll` — GAC assembly
- A working Windows microphone for dictation (optional at install; required for use)

## Security / Distribution Notes

- **Code signing**: Not applied. `Talkity.exe` does not contain an Authenticode signature. If distributing to users, sign with an EV or OV certificate using `signtool.exe` from the Windows SDK before release.
- **No secrets embedded**: No API keys, WebSocket URLs with tokens, or user data are inside the executable.
- **No telemetry / updates**: No automatic update mechanism, no telemetry payload, no online tracking.
- **No admin requirement**: The application runs with standard user privileges.

## Windows Compatibility

- Works on Windows 10 Pro (build 19045) and Windows 11.
- Uses `RegisterHotKey` (global) — requires no admin for user-level shortcuts.
- Uses `System.Speech.Recognition.SpeechRecognitionEngine` — requires Windows Speech platform installed.
- Playback / clipboard injection uses `keybd_event` — may be blocked by UAC-elevated targets or protected applications.

## Installer Status

No MSI / MSIX / WiX-built installer is provided in this release because:
- The executable is fully portable.
- Per-user installation does not require elevation.
- User settings are kept outside the install directory by design.

If an MSI is required for organizational deployment, use `build/app.bat` with WiX (see `release/TalkityInstaller.wxs` as a skeleton), build with `candle` + `light`, and sign with `signtool`.

## Release Checklist

- [x] Source builds reproducibly (`build_app.bat`)
- [x] All unit tests pass (`build_tests.bat`, 149 passed)
- [x] Executable launches and exits correctly (verified)
- [x] Protocol v1.0.0 preserved (`TalkityWsClient` unchanged)
- [x] Settings / history / logs go to `%APPDATA%\Talkity\`
- [x] No secrets in executable or source
- [x] No telemetry or automatic updates added
- [ ] Windows integration test — manual dictation into Notepad, Word, browser
- [ ] Global hotkey test — F8 in foreground app (requires Windows desktop)
- [ ] Clipboard restore verification — paste in protected fields (requires Windows)
- [ ] HUD drag/reposition test (requires mouse interaction)
- [ ] System tray behavior — hide/show/exit (requires Windows tray session)
- [ ] Code signing with EV/OV certificate (pending)
- [ ] MSI installer build (optional; skeleton `release/TalkityInstaller.wxs` provided)

---
*Release build produced at: 2026-10-25*
*Environment: Windows 10 Pro 10.0.19045 / .NET Framework 4.8*
