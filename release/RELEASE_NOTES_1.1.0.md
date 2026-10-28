# Talkity 1.1.0 — Release Notes

**Release date:** 28 October 2026
**Installer:** `TalkitySetup.exe` (2,140,042 bytes)
**SHA256:** `10AE8359CE5E1508E758D612FE4AB880940C0C291B48AA03DE089B38CFFAEFCE`
**Source:** tag `v1.1.0`

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
* .NET Framework 4.0 or later. Included with Windows 10/11; the installer refuses
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

Executed on this machine (non-elevated session, no clean VM):

* C# suite: **297 passed, 0 failed**; Node suites: all pass.
* Application build: exit 0, version resource 1.1.0.0.
* Live launch: WebSocket connected, server acknowledged, `connected=true`;
  settings file unchanged across restarts.
* Live dictation against the production endpoint: HTTP 200, language detection
  working, clipboard fallback used when Talkity itself held focus.
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

These require a clean Windows environment and/or hardware not available here:

1. Install on a clean Windows 10 and a clean Windows 11 VM, per-machine (UAC),
   and confirm the app launches from the Start Menu shortcut.
2. Dictate with a real microphone and confirm automatic insertion into Notepad,
   a browser text field and an Office application.
3. Confirm settings, hotkey and HUD position persist across an app restart and
   across an upgrade.
4. Upgrade from the previously distributed build (if any) and confirm a single
   Add/Remove Programs entry remains.
5. Uninstall through Settings → Apps and confirm `%APPDATA%\Talkity` is kept.
6. Verify behaviour with SmartScreen and at least one antivirus product.
7. Test on a non-English Windows installation and at 125 %/150 % display scaling.
8. Test with a second Windows user account (per-machine install, separate
   `%APPDATA%`).
9. Enable "Launch at startup" and reboot to confirm the tray app starts hidden
   and connects.
