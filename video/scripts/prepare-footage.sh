#!/bin/bash
# Build the privately redacted footage masters and stills that the composition reads.
# Input: the two raw worker recordings (Playwright recordVideo, 1920x1080, 25 fps). They contain the
# disposable inbox address and are never committed. Output: public/footage/ (gitignored).
#   usage: scripts/prepare-footage.sh <worker1.webm> <worker2.webm>
set -euo pipefail
cd "$(dirname "$0")/.."
W1=$1; W2=$2; OUT=public/footage; mkdir -p "$OUT"
FILL="color=0xEEEDE6@1:t=fill"   # the login field's own background colour: the field reads as empty
# 1. Frames showing the /login page (orange OR badge). The email field is filled on exactly those frames.
python3 scripts/detect_login_frames.py "$W1"; python3 scripts/detect_login_frames.py "$W2"
# Ranges found for the 2026-10-27 run: worker 1 frames 24-30 and 384-400, worker 2 frames 410-605.
# Worker 1 frames 0-39 (signup step 1 and the top of signup page 2, where the address is shown in other
# fields) are dropped entirely: the master starts at frame 40 (1.6 s).
ffmpeg -v error -y -i "$W1" -vf "drawbox=x=488:y=305:w=360:h=40:${FILL}:enable='between(n,384,400)',trim=start_frame=40,setpts=PTS-STARTPTS" \
  -c:v libx264 -crf 10 -preset slow -pix_fmt yuv420p -r 25 -an "$OUT/w1.mp4"
ffmpeg -v error -y -i "$W2" -vf "drawbox=x=488:y=305:w=360:h=40:${FILL}:enable='between(n,410,605)'" \
  -c:v libx264 -crf 10 -preset slow -pix_fmt yuv420p -r 25 -an "$OUT/w2.mp4"
# 2. Verify: on every login-page frame the email field holds no text pixels.
python3 scripts/verify_redaction.py "$OUT/w1.mp4"; python3 scripts/verify_redaction.py "$OUT/w2.mp4"
# 3. Stills (from the redacted masters only).
still() { ffmpeg -v error -y -ss "$2" -i "$OUT/$1.mp4" -frames:v 1 "$OUT/$3.png"; }
still w1 0.5 w1_form; still w1 3.0 w1_created; still w1 17.0 w1_home
still w2 7.80 w2_restored; still w2 10.0 w2_deleted; still w2 18.0 w2_refused
echo "footage ready in $OUT"
