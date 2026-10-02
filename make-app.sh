#!/bin/bash
# Build ~/Applications/Transcriber.app, a double-click launcher for launch.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Transcriber.app"
rm -rf "$APP"
/usr/bin/osacompile -o "$APP" -e "do shell script quoted form of \"$DIR/launch.sh\" & \" >/dev/null 2>&1\""
# Borrow a system speech icon if present; otherwise keep the AppleScript default.
ICON=/System/Applications/Automator.app/Contents/Resources/Speech.icns
[ -f "$ICON" ] || ICON=/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ClippingSound.icns
if [ -f "$ICON" ]; then
  cp "$ICON" "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"
  /usr/bin/plutil -remove CFBundleIconName "$APP/Contents/Info.plist" 2>/dev/null
fi
/usr/bin/codesign --force --sign - "$APP" 2>/dev/null   # re-sign after editing the bundle
touch "$APP"
echo "Built $APP"
