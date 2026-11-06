Add-Type -AssemblyName System.Speech
$engine = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
Write-Host "Total recognizers: $($engine.Count)"
foreach ($r in $engine) {
    Write-Host "  Id: $($r.Id)"
    Write-Host "  Name: $($r.Name)"
    Write-Host "  Culture: $($r.Culture.Name)"
    Write-Host "  Description: $($r.Description)"
    Write-Host ""
}