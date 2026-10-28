param(
    [string]$Endpoint = "https://talkity-qifh.onrender.com",
    [string]$OutputDir = "",
    [int]$DeviceId = -1,
    [string]$Language = "",
    [int]$Seconds = 8,
    [switch]$SkipRecording
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $PSScriptRoot "mic-validation"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$harness = Join-Path $OutputDir "MicValidationHarness.exe"
$harnessSource = Join-Path $PSScriptRoot "MicValidationHarness.cs"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"

if (-not (Test-Path $harness) -or (Get-Item $harnessSource).LastWriteTime -gt (Get-Item $harness).LastWriteTime) {
    Write-Host "Compiling microphone harness..."
    & $csc /nologo /target:exe /out:$harness /r:System.dll `
        (Join-Path $repoRoot "desktop\TalkityWhisperRecorder.cs") `
        (Join-Path $repoRoot "desktop\TalkityAudioDiagnostics.cs") `
        (Join-Path $repoRoot "desktop\TalkityLog.cs") `
        $harnessSource
    if ($LASTEXITCODE -ne 0) { throw "Harness compile failed with exit code $LASTEXITCODE" }
}

$references = @(
    @{ id = 1;  reference = "The quick brown fox jumps over the lazy dog." },
    @{ id = 2;  reference = "Hello world, how are you today?" },
    @{ id = 3;  reference = "Please dictate this sentence accurately." },
    @{ id = 4;  reference = "Talkity connects to the server for processing." },
    @{ id = 5;  reference = "Piyush is testing Antigravity and UI Automation with Talkity." },
    @{ id = 6;  reference = "This sentence has numbers: one two three four five." },
    @{ id = 7;  reference = "Um, I think, you know, we should ship this today." },
    @{ id = 8;  reference = "I am testing Whisper Large V3 with a known reference text." },
    @{ id = 9;  reference = "Thanks, let's meet at 3:30 p.m. in Room 204." },
    @{ id = 10; reference = "Schedule a meeting with Piyush tomorrow at 3:30 p.m. in Room 204." },
    @{ id = 11; reference = "Hello Talkity, this is a test of Talkity. I am checking whether my voice is converted into accurate text and insert automatically." },
    @{ id = 12; reference = "Aaj main office ja raha hoon, meeting 3:30 p.m. par hai."; qualitative = $true }
)

$manifest = @()
foreach ($item in $references) {
    $file = "rec-{0:00}.wav" -f $item.id
    $manifest += [pscustomobject]@{
        id = $item.id
        reference = $item.reference
        file = $file
        qualitative = [bool]$item.qualitative
    }
}

if (-not $SkipRecording) {
    Write-Host ""
    Write-Host "Real-microphone accuracy capture"
    Write-Host "--------------------------------"
    Write-Host "Use the microphone you normally use with Talkity. Sit in a quiet room."
    Write-Host "For each sentence: read it once, naturally, immediately after the beep."
    Write-Host "The recorder runs for $Seconds seconds. Do not speak before the beep."
    Write-Host "Device ID: $DeviceId (-1 = Windows default input device)"
    Write-Host ""

    foreach ($item in $references) {
        Write-Host ""
        Write-Host ("[{0}] {1}" -f $item.id, $item.reference) -ForegroundColor Cyan
        if ($item.qualitative) {
            Write-Host "     (Hindi-English mixed: say it naturally; this case is qualitative, not in the WER aggregate.)" -ForegroundColor DarkYellow
        }
        Write-Host "     Recording in 3..." -NoNewline
        Start-Sleep -Seconds 1
        Write-Host " 2..." -NoNewline
        Start-Sleep -Seconds 1
        Write-Host " 1..." -NoNewline
        Start-Sleep -Seconds 1
        Write-Host " GO"
        [console]::Beep(880, 150)

        $outFile = Join-Path $OutputDir $file
        & $harness --record-only --seconds $Seconds --in-device $DeviceId --out $outFile
        if ($LASTEXITCODE -ne 0) { throw "Recording failed for item $($item.id)" }
        Write-Host "     Saved $file" -ForegroundColor Green
    }
}

$manifestPath = Join-Path $OutputDir "manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $manifestPath
Write-Host ""
Write-Host "Manifest: $manifestPath"

$scoreArgs = @((Join-Path $PSScriptRoot "score_mic.js"), $manifestPath, "--endpoint", $Endpoint)
if (-not [string]::IsNullOrWhiteSpace($Language)) {
    $scoreArgs += @("--language", $Language)
}
& node @scoreArgs
if ($LASTEXITCODE -ne 0) { throw "Scoring failed with exit code $LASTEXITCODE" }

Write-Host ""
Write-Host "Done. Results: $(Join-Path $OutputDir 'results.json')"
Write-Host "Recordings and results are local; no audio is uploaded anywhere except the configured Talkity endpoint."
