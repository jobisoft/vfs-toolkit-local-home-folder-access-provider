#!/usr/bin/env bash
# Uninstall the expose_home_folder_host native messaging host for Thunderbird on Linux/macOS.

set -euo pipefail

if [[ "$OSTYPE" == darwin* ]]; then
  DEST="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  DEST="$HOME/.mozilla/native-messaging-hosts"
fi

MANIFEST="$DEST/expose_home_folder_host.json"

if [[ -f "$MANIFEST" ]]; then
  rm "$MANIFEST"
  echo "Removed: $MANIFEST"
else
  echo "Not installed (not found): $MANIFEST"
fi
