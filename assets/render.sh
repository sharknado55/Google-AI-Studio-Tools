#!/usr/bin/env bash
# Renders assets/banner.html to PNGs with headless Chrome.
#   banner.png  1920x1080  (README header)
#   social.png  1280x640   (GitHub social preview: Settings > General > Social preview)
# Usage: bash assets/render.sh   (set CHROME=/path/to/chrome if it is not found)
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in "/c/Program Files/Google/Chrome/Application/chrome.exe" google-chrome chromium chromium-browser \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
url="file:///$(pwd -W 2>/dev/null || pwd)/banner.html"
shot() { # out width height scale query
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=8000 \
    --window-size="$2,$3" --force-device-scale-factor="$4" --screenshot="$PWD/$1" "$url$5" >/dev/null 2>&1
  echo "wrote $1"
}
shot banner.png 1920 1080 1 ''
shot social.png 1920 960 0.6666667 '?social'
