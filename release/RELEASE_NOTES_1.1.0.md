# Talkity 1.1.0 — Release Notes

**Release date:** 28 October 2026
**Installer:** `TalkitySetup.exe` (2,140,040 bytes)
**SHA256:** `13B97A4D83F03317B21FF2D5BC1F33848F1CD3DFCA7219CDF28B1D7F0C964179`
**Source:** tag `v1.1.0` (see `release\RELEASE.md` — tags are published separately
from commits)

This is the first packaged Windows release of the Talkity desktop client. Earlier
tags contained the protocol work and the browser extension only; the C# desktop
application had never been committed or distributed.

## What's included

Talkity is a push-to-talk dictation utility for Windows. It records from the
default microphone, sends the clip to the Talkity service for Whisper
transcription, and inserts the result into whatever application has focus.

* Server-side Whisper transcription over HTTPS, with automatic language
  detection (English and Hindi observed in production).
* Global hotkey (default `F8`) to start and stop dictation.
* Floating HUD showing listening, processing and result states.
* Text insertion into the foreground window, falling back to the clipboard when
  no target window can be captured.
* Settings, transcript history and diagnostics persisted in
  `%APPDATA%\Talkity` (`settings.json`, `history.json`, `talkity.log`).
* WebSocket protocol v1.0.0 client, reconnecting to
  `wss://talkity-qifh.onrender.com/` with exponential backoff.
* Optional enhancement pass, tone selection, sound cues, run-at-startup.
* Manifest V3 browser extension updated alongside the desktop client.

## Fixed in this release

* **Background start crashed on launch.** Starting `Talkity.exe --background`
  — the path used by the app's own "Launch at startup" setting — terminated the
  process with an unhandled `InvalidOperationException` as soon as the WebSocket
  connected, because the hidden main window had no handle for `BeginInvoke`.
  The handle is now created without showing the window. Verified: the process
  stays alive and reports `connected=true`.
* **No version metadata.** The executable now carries
  `FileVersion`/`ProductVersion` 1.1.0.0 and product/company information, so
  Explorer, Add/Remove Programs and crash reports identify the build.
* **No application icon.** A generated multi-size icon is embedded in the
  executable and used by the installer and shortcuts.

No transcription, insertion, settings or protocol logic was changed.

## Installation

1. Run `TalkitySetup.exe`.
2. Windows SmartScreen may warn that the publisher is unknown — the installer is
   not code-signed (see Known limitations).
3. Accept the UAC prompt. The default install is per-machine, into
   `C:\Program Files\Talkity`.
4. Start Menu → Talkity. A desktop shortcut is optional (unchecked by default).
5. Allow microphone access when Windows asks. Press `F8` in any application to
   dictate.

Administrators without elevation can install per-user instead:

```bat
TalkitySetup.exe /CURRENTUSER
```

which installs into `%LOCALAPPDATA%\Programs\Talkity` without a UAC prompt.

Silent deployment:

```bat
TalkitySetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

## Requirements

* Windows 10 or Windows 11 (Windows 7 SP1+ is permitted by the package, but is
  untested).
* .NET Framework 4.5 or later. Included with Windows 10/11; the installer refuses
  to run and explains how to obtain it if it is missing.
* A working microphone and an internet connection to the Talkity service.
* No admin rights are needed to *run* the app, only to install it per-machine.

## Upgrade behaviour

* Upgrades replace the previous version in place (stable `AppId`), keeping the
  install directory and shortcut choices.
* A running Talkity is closed before files are replaced. During a silent upgrade
  it is relaunched in the background afterwards.
* Settings, history and logs in `%APPDATA%\Talkity` are never modified by the
  installer and survive both upgrades and uninstalls.
* An autostart entry pointing at the app is restored after an upgrade when
  `"launchAtStartup": true` is still set in `settings.json`.

## Verification performed

Executed on Windows 10 Pro 22H2 (build 19045), 64-bit, .NET Framework 4.8.09037,
in a non-elevated session. No clean VM and no Windows 11 machine was available.

* C# suite: **297 passed, 0 failed**; Node suites: all pass.
* Application build: exit 0, version resource 1.1.0.0.
* Live launch: WebSocket connected, server acknowledged, `connected=true`;
  settings file unchanged across restarts.
* Live dictation against the production endpoint — HTTP 200, language detection
  and clipboard fallback when Talkity itself held focus — was recorded **before**
  the packaging changes, using the same unchanged transcription code. It was
  **not** re-run from the installed build; that remains a manual test below.
* Installer: fresh per-user install, upgrade over a running instance, uninstall,
  reinstall with the desktop-shortcut task, uninstall — all exit code 0, with
  shortcuts, ARP entry, install-directory contents, autostart entry and user
  data checked at each step.

## Known limitations

* **Unsigned.** No code-signing certificate is available, so SmartScreen shows an
  "unknown publisher" warning and some antivirus products may flag an unsigned
  installer.
* **No EULA page.** The repository has no licence file, so the installer has no
  licence step.
* **Placeholder icon.** The mark is generated by
  `release\installer\make_icon.ps1`, not a brand asset. Replace it before public
  distribution.
* **Tray icon is generic.** The application still uses the stock Windows
  application icon in the notification area; changing it requires an app code
  change that was out of scope here.
* **No automatic updates.** Users must download and run a new
  `TalkitySetup.exe`.
* **Per-machine install unverified.** The default elevated path could not be
  exercised in this session; only the per-user path was installed and removed.
* **Desktop shortcut is opt-in** and unchecked by default.

## Remaining manual tests

None of the checks below were performed for v1.1.0. They require a clean Windows
machine, elevation, and a real microphone, none of which were available. Treat
this list as the gate between "release candidate" and "public release".

### Installation and lifecycle

| # | Test | Environment | Pass criteria |
|---|------|-------------|---------------|
| 1 | Clean install, per-machine | Clean Windows 10 VM, admin user | UAC prompt appears, install completes, `C:\Program Files\Talkity\Talkity.exe` exists, Start Menu shortcut launches the app |
| 2 | Clean install, per-machine | Clean Windows 11 VM, admin user | Same as #1; Windows 11 was never exercised |
| 3 | Per-user install | Non-admin Windows account | `TalkitySetup.exe /CURRENTUSER` installs to `%LOCALAPPDATA%\Programs\Talkity` with no UAC prompt |
| 4 | Apps & Features entry | Any | Exactly one "Talkity 1.1.0" entry, publisher "Talkity", correct icon and version |
| 5 | Upgrade over running app | Machine with a previous build | Running instance closes, files are replaced, app relaunches and reconnects, one Apps & Features entry remains, settings/hotkey/HUD position unchanged |
| 6 | Uninstall | Apps & Features → Talkity → Uninstall | App closes, install dir and both shortcuts removed, Apps & Features entry gone, `%APPDATA%\Talkity` (settings, history, log) still present and unmodified |

### SmartScreen and antivirus

| # | Test | Environment | Pass criteria |
|---|------|-------------|---------------|
| 7 | SmartScreen first run | Machine that has never seen the binary | Warning is the expected "unknown publisher" for an unsigned installer; "More info → Run anyway" completes the install |
| 8 | Antivirus scan | Windows Defender plus one third-party AV | `TalkitySetup.exe` and the installed `Talkity.exe` are neither quarantined nor blocked; no false positive reported |

### Application behaviour on the installed build

| # | Test | Environment | Pass criteria |
|---|------|-------------|---------------|
| 9 | Microphone dictation | Machine with a real microphone | `F8` starts and stops recording, HUD moves Listening → Processing → result, transcript returned |
| 10 | Automatic text insertion | Notepad, a browser text field, an Office app | Text is inserted at the caret without manual paste; clipboard fallback only when no target window can be captured |
| 11 | Settings persistence | Restart and upgrade | Hotkey, language, engine, HUD position and tone survive both |
| 12 | Launch at startup | Enable in Settings, then reboot | Tray app starts hidden (`--background`), connects, and shows no main window |
| 13 | Non-English Windows, 125 %/150 % scaling | Localised Windows VM | HUD and settings dialog render correctly; hotkey still registers |
| 14 | Second Windows user | Per-machine install, second account | Each user gets a separate `%APPDATA%\Talkity`; uninstalling does not affect the other account's data |

Sections 1–9 of `desktop\MANUAL_VALIDATION_CHECKLIST.md` cover transcription
accuracy and insertion behaviour in more detail.
