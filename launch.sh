#!/bin/bash
# Start the transcriber server if it isn't already running, then open it in the browser.
PORT="${TRANSCRIBER_PORT:-8765}"
URL="http://127.0.0.1:$PORT/"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/Transcriber.log"
PY=/opt/homebrew/bin/python3
[ -x "$PY" ] || PY=/usr/bin/python3

if ! /usr/bin/curl -fs -o /dev/null "${URL}api/status"; then
  nohup "$PY" "$DIR/transcriber.py" </dev/null >>"$LOG" 2>&1 &
  for _ in $(seq 1 50); do
    /usr/bin/curl -fs -o /dev/null "${URL}api/status" && break
    sleep 0.1
  done
fi
[ -n "$TRANSCRIBER_NO_OPEN" ] || /usr/bin/open "$URL"
