#!/bin/bash
# Find chromium executable
CHROMIUM=$(which chromium || which chromium-browser || which google-chrome || find /nix -name "chromium" -type f 2>/dev/null | head -1)
echo "Found Chromium at: $CHROMIUM"
export PUPPETEER_EXECUTABLE_PATH="$CHROMIUM"
node server.js
