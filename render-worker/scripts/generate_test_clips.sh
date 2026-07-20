#!/usr/bin/env bash
# scripts/generate_test_clips.sh
#
# Generates synthetic MP4 clips of different resolutions and frame rates
# for use in unit and integration tests. These clips are:
#   - Silent (no audio track) — audio is provided separately as a voiceover
#   - Short (3 seconds each) — keeps test runtime fast
#   - Distinct resolutions/fps to exercise the normalisation filter chain
#
# Usage:
#   bash scripts/generate_test_clips.sh [output_dir]
#   output_dir defaults to tests/fixtures/clips

set -euo pipefail

OUTPUT_DIR="${1:-tests/fixtures/clips}"
mkdir -p "$OUTPUT_DIR"

# Check ffmpeg is available
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found in PATH" >&2
  exit 1
fi

echo "Generating synthetic test clips in $OUTPUT_DIR ..."

# Helper: generate a solid-colour silent video clip
# Args: output_path  width  height  fps  duration_seconds  colour
gen_clip() {
  local out="$1" w="$2" h="$3" fps="$4" dur="$5" colour="${6:-0x3366cc}"
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=${colour}:size=${w}x${h}:rate=${fps}:duration=${dur}" \
    -an \
    -c:v libx264 -preset ultrafast -crf 28 \
    -pix_fmt yuv420p \
    "$out"
  echo "  ✓ $out  (${w}x${h} @ ${fps}fps, ${dur}s)"
}

# Clip 1: 1280x720 @ 24fps  — HD portrait
gen_clip "$OUTPUT_DIR/clip_720_24fps.mp4"  1280 720  24 3 0x3366cc

# Clip 2: 1366x768 @ 60fps  — odd laptop resolution (common source of v1 failures)
gen_clip "$OUTPUT_DIR/clip_768_60fps.mp4"  1366 768  60 3 0xcc3366

# Clip 3: 1920x1080 @ 30fps — Full HD
gen_clip "$OUTPUT_DIR/clip_1080_30fps.mp4" 1920 1080 30 3 0x66cc33

# Clip 4: 640x480 @ 15fps  — old low-res source
gen_clip "$OUTPUT_DIR/clip_480_15fps.mp4"  640  480  15 3 0xcc6633

# Generate a silent audio track (sine wave at low volume — represents voiceover)
AUDIO_OUT="$OUTPUT_DIR/audio_voiceover.mp3"
ffmpeg -y -loglevel error \
  -f lavfi -i "sine=frequency=440:duration=12" \
  -c:a libmp3lame -b:a 128k \
  "$AUDIO_OUT"
echo "  ✓ $AUDIO_OUT  (12s, 440Hz sine)"

# For 50-clip stress test: generate 50 identical clips quickly via symlinks or copies
STRESS_DIR="$OUTPUT_DIR/stress_50"
mkdir -p "$STRESS_DIR"

# Generate 3 base clips with varied resolutions for the stress test
gen_clip "$STRESS_DIR/base_a.mp4" 1280 720  24 2 0x112233
gen_clip "$STRESS_DIR/base_b.mp4" 1920 1080 30 2 0x332211
gen_clip "$STRESS_DIR/base_c.mp4" 1366 768  60 2 0x213312

# Create 50 clips by cycling through the 3 bases
for i in $(seq -w 1 50); do
  idx=$(( (10#$i - 1) % 3 ))
  case $idx in
    0) src="$STRESS_DIR/base_a.mp4" ;;
    1) src="$STRESS_DIR/base_b.mp4" ;;
    2) src="$STRESS_DIR/base_c.mp4" ;;
  esac
  cp "$src" "$STRESS_DIR/clip_${i}.mp4"
done

# 12-second audio for the 50-clip test (50 clips × 2s = 100s, audio loops anyway)
ffmpeg -y -loglevel error \
  -f lavfi -i "sine=frequency=220:duration=120" \
  -c:a libmp3lame -b:a 128k \
  "$STRESS_DIR/audio.mp3"

echo ""
echo "Done. Generated $(find "$OUTPUT_DIR" -name '*.mp4' | wc -l) clip(s) and $(find "$OUTPUT_DIR" -name '*.mp3' | wc -l) audio file(s)."
