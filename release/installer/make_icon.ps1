<#
  Generates release\installer\talkity.ico - a multi-size Windows icon used by
  the application executable and by TalkitySetup.exe.

  This is a neutral placeholder mark (voice waveform on a gradient tile). Replace
  it with the real brand asset when one exists; the rest of the build is
  unaffected as long as the file name stays talkity.ico.

  Usage (from the repository root):
      powershell -ExecutionPolicy Bypass -File release\installer\make_icon.ps1
#>

Add-Type -AssemblyName System.Drawing

$outPath = Join-Path $PSScriptRoot 'talkity.ico'
$sizes   = 16, 20, 24, 32, 40, 48, 64, 128, 256

function New-RoundedRectPath([single]$w, [single]$h, [single]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    if ($d -gt $w) { $d = $w }
    if ($d -gt $h) { $d = $h }
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($w - $d, 0, $d, $d, 270, 90)
    $path.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
    $path.AddArc(0, $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconPng([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Tile
    $pad    = [single]($s * 0.02)
    $tile   = [single]($s - (2 * $pad))
    $radius = [single]($s * 0.22)
    $tilePath = New-RoundedRectPath $tile $tile $radius

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF($tile, $tile)),
        [System.Drawing.Color]::FromArgb(255, 67, 56, 202),
        [System.Drawing.Color]::FromArgb(255, 6, 182, 212))
    $g.TranslateTransform($pad, $pad)
    $g.FillPath($brush, $tilePath)

    # Waveform bars (white)
    $bars    = @(0.30, 0.56, 0.80, 0.56, 0.30)
    $barW    = [single]($tile * 0.088)
    $gap     = [single]($tile * 0.056)
    $total   = ($bars.Count * $barW) + (($bars.Count - 1) * $gap)
    $startX  = [single](($tile - $total) / 2)
    $white   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    for ($i = 0; $i -lt $bars.Count; $i++) {
        $barH = [single]($tile * $bars[$i])
        $x    = [single]($startX + ($i * ($barW + $gap)))
        $y    = [single](($tile - $barH) / 2)
        $barPath = New-RoundedRectPath $barW $barH ([single]($barW / 2))
        $g.TranslateTransform($x, $y)
        $g.FillPath($white, $barPath)
        $g.TranslateTransform(-$x, -$y)
        $barPath.Dispose()
    }

    $white.Dispose()
    $brush.Dispose()
    $tilePath.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $g.Dispose()
    $bmp.Dispose()
    return ,$bytes
}

# Render every size first so the ICO directory can be written before the data.
$blobs = @{}
foreach ($s in $sizes) { $blobs[$s] = New-IconPng $s }

$fs = [System.IO.File]::Create($outPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
    $bw.Write([UInt16]0)                # reserved
    $bw.Write([UInt16]1)                # type: icon
    $bw.Write([UInt16]$sizes.Count)     # image count

    $offset = 6 + (16 * $sizes.Count)
    foreach ($s in $sizes) {
        $dim = if ($s -ge 256) { 0 } else { $s }
        $bw.Write([Byte]$dim)           # width  (0 = 256)
        $bw.Write([Byte]$dim)           # height (0 = 256)
        $bw.Write([Byte]0)              # palette colours
        $bw.Write([Byte]0)              # reserved
        $bw.Write([UInt16]1)            # colour planes
        $bw.Write([UInt16]32)           # bits per pixel
        $bw.Write([UInt32]$blobs[$s].Length)
        $bw.Write([UInt32]$offset)
        $offset += $blobs[$s].Length
    }
    foreach ($s in $sizes) { $bw.Write($blobs[$s]) }
}
finally {
    $bw.Close()
    $fs.Close()
}

# Standalone preview so the mark can be reviewed without an icon viewer.
$previewPath = Join-Path $env:TEMP 'talkity-icon-preview.png'
[System.IO.File]::WriteAllBytes($previewPath, $blobs[256])

Write-Output ("Wrote {0} ({1} bytes, {2} sizes)" -f $outPath, (Get-Item $outPath).Length, $sizes.Count)
Write-Output ("Preview: {0}" -f $previewPath)
