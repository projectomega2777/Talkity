# Talkity Desktop — Release Engineering

How the Windows build and installer are produced, and what has actually been
verified. Release notes for the current version live in
`release\RELEASE_NOTES_1.1.0.md`.

## Requirements

| Requirement | Notes |
|-------------|-------|
| Windows 10 / 11 | Development and target platform |
| .NET Framework 4.x | Supplies `csc.exe` and `System.Speech` (GAC) |
| Inno Setup 6.7.3 | Installer compiler only; see `release\installer\README.md` |

The application itself needs no NuGet packages, native libraries, VC++ runtime
or admin rights. It is AnyCPU IL-only code, so it runs 64-bit on 64-bit Windows.

## Build

```bat
build_app.bat
```

Produces `Talkity.exe` in the repository root: `AssemblyVersion`/`FileVersion`
1.1.0.0, product name `Talkity`, embedded application icon. Expect
`Build exited with code 0`.

Close Talkity first — `csc.exe` cannot overwrite a running executable
(`CS0016 ... being used by another process`).

## Tests

```bat
build_tests_run.bat     :: compiles and runs TalkityTests.exe
npm run test:all        :: node test.js && node test_extension.js && node test_server_transcribe.js
```

Expected: `Results: 297 passed, 0 failed` and `[ALL TESTS PASSED]` for the C#
suite; all three Node suites pass.

`Polish skipped: endpoint has no HTTP equivalent` is expected output — the suite
deliberately exercises `TalkityPolish.Enhance("ftp://nope", ...)`.

## Installer

```bat
release\installer\build_installer.bat
```

Produces `release\output\TalkitySetup.exe` (gitignored). Details of the install,
upgrade and uninstall behaviour are documented in
`release\installer\README.md`.

## Release checklist

1. `git status` clean, on `main`.
2. `build_app.bat` → exit code 0.
3. `build_tests_run.bat` → 297 passed, 0 failed.
4. `npm run test:all` → all suites pass.
5. Launch `Talkity.exe`, confirm `WebSocket connected` and
   `Server acknowledged connection` in `%APPDATA%\Talkity\talkity.log`.
6. `release\installer\build_installer.bat` → `Successful compile`.
7. Install, upgrade over a running instance, uninstall; confirm
   `%APPDATA%\Talkity` survives.
8. Record the SHA256 of `TalkitySetup.exe` in the release notes.
9. Tag: `git tag -a v1.1.0 -m "Talkity 1.1.0"`.

## Verification log — 2026-10-28

Environment: Windows 10/11 desktop, non-elevated user session, no clean VM.

| Check | Result |
|-------|--------|
| `build_tests_run.bat` (before changes) | 297 passed, 0 failed |
| `npm run test:all` (before changes) | all suites pass |
| Merge `origin/main` into `phase3-csharp-client` | clean, no conflicts |
| `server.js` / `data/dictionary.json` vs `origin/main` | byte-identical |
| `build_tests_run.bat` (after merge) | 297 passed, 0 failed |
| `build_app.bat` (after merge) | exit 0 |
| `Talkity.exe` version resource | 1.1.0.0, `Talkity` |
| Launch + WebSocket | connected, server acknowledged, `connected=true` |
| Settings persistence across restart | `settings.json` hash unchanged |
| Live dictation (production endpoint) | HTTP 200, language detection (Hindi/English) |
| `Talkity.exe --background` | crashed before fix, stays connected after fix |
| Fresh install (per-user) | exit 0, files/shortcuts/ARP correct |
| Upgrade over running instance | app closed, files replaced, app relaunched and connected |
| Autostart entry across upgrade | preserved (removed by old uninstaller, restored after) |
| Uninstall | exit 0, app files/shortcuts/ARP/Run entry removed |
| User data after uninstall | `settings.json` byte-identical, `history.json` intact |
| Desktop-shortcut task | shortcut created, removed on uninstall |
| Per-machine install (UAC) | **not tested** — session not elevated |
| Clean VM install/upgrade/uninstall | **not tested** — no clean environment available |
| Code signature | **unsigned** — no certificate available |

## Artifacts

| File | Notes |
|------|-------|
| `Talkity.exe` | Built by `build_app.bat`, gitignored |
| `release\output\TalkitySetup.exe` | Built by `build_installer.bat`, gitignored |
| `release\installer\Talkity.iss` | Installer definition |
| `release\installer\talkity.ico` | Generated icon (app + setup) |

Build outputs are gitignored on purpose: a release is rebuilt from source, not
committed as a binary blob.
