# scripts/generate_test_clips.ps1
# Generates synthetic MP4 test clips using FFmpeg on Windows.
# Run from the render-worker directory: pwsh scripts/generate_test_clips.ps1

param(
    [string]$OutputDir = "tests/fixtures/clips"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Check ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "FFmpeg not found in PATH. Install from https://ffmpeg.org/download.html"
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function New-Clip {
    param([string]$Out, [int]$W, [int]$H, [int]$Fps, [int]$Dur, [string]$Colour = "0x3366cc")
    $args = @(
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=${Colour}:size=${W}x${H}:rate=${Fps}:duration=${Dur}",
        "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p",
        $Out
    )
    & ffmpeg @args
    Write-Host "  [OK] $Out  (${W}x${H} @ ${Fps}fps, ${Dur}s)"
}

Write-Host "Generating synthetic test clips in $OutputDir ..."

# Main test clips
New-Clip "$OutputDir/clip_720_24fps.mp4"  1280 720  24 3 "0x3366cc"
New-Clip "$OutputDir/clip_768_60fps.mp4"  1366 768  60 3 "0xcc3366"
New-Clip "$OutputDir/clip_1080_30fps.mp4" 1920 1080 30 3 "0x66cc33"
New-Clip "$OutputDir/clip_480_15fps.mp4"  640  480  15 3 "0xcc6633"

# Voiceover audio (sine wave, 12 seconds)
$audioOut = "$OutputDir/audio_voiceover.mp3"
& ffmpeg -y -loglevel error `
    -f lavfi -i "sine=frequency=440:duration=12" `
    -c:a libmp3lame -b:a 128k `
    $audioOut
Write-Host "  [OK] $audioOut  (12s, 440Hz sine)"

# ─── Stress test: 50 clips ───────────────────────────────────────────────────
$StressDir = "$OutputDir/stress_50"
New-Item -ItemType Directory -Force -Path $StressDir | Out-Null

New-Clip "$StressDir/base_a.mp4" 1280 720  24 2 "0x112233"
New-Clip "$StressDir/base_b.mp4" 1920 1080 30 2 "0x332211"
New-Clip "$StressDir/base_c.mp4" 1366 768  60 2 "0x213312"

$bases = @("$StressDir/base_a.mp4", "$StressDir/base_b.mp4", "$StressDir/base_c.mp4")
for ($i = 1; $i -le 50; $i++) {
    $src = $bases[($i - 1) % 3]
    $dest = "$StressDir/clip_$('{0:D2}' -f $i).mp4"
    Copy-Item $src $dest -Force
}

& ffmpeg -y -loglevel error `
    -f lavfi -i "sine=frequency=220:duration=120" `
    -c:a libmp3lame -b:a 128k `
    "$StressDir/audio.mp3"

$clipCount = (Get-ChildItem $OutputDir -Recurse -Filter "*.mp4").Count
$audioCount = (Get-ChildItem $OutputDir -Recurse -Filter "*.mp3").Count
Write-Host ""
Write-Host "Done. Generated $clipCount clip(s) and $audioCount audio file(s)."
