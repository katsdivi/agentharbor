#!/usr/bin/env bash
# Two-pass loudness normalisation of the rendered film's soundtrack to -16 LUFS / -1.5 dBTP
# (web/online-video level). The video stream is copied untouched.
# Usage: scripts/master-audio.sh out/agentharbor-product-film.mp4 out/agentharbor-product-film-mastered.mp4
set -euo pipefail
in="$1"; out="$2"
target="I=-16:TP=-1.5:LRA=11"
stats=$(ffmpeg -hide_banner -nostats -i "$in" -af "loudnorm=${target}:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { printf '%s' "$stats" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
ffmpeg -hide_banner -v error -y -i "$in" -c:v copy \
  -af "loudnorm=${target}:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true" \
  -ar 48000 -c:a aac -b:a 192k -movflags +faststart "$out"
ffmpeg -hide_banner -nostats -i "$out" -af loudnorm=print_format=summary -f null - 2>&1 | grep -E "Input (Integrated|True Peak)"
