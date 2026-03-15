#!/usr/bin/env bash
# Install the expose_home_folder_host native messaging host for Thunderbird on Linux/macOS.
# Run once after cloning; re-run if you move the directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FS_PY="$SCRIPT_DIR/expose_home_folder_host.py"
MANIFEST="$SCRIPT_DIR/expose_home_folder_host.json"
TMP_MANIFEST="$(mktemp)"

# Make the Python script executable
chmod +x "$FS_PY"

# Write a manifest with the absolute path filled in
sed "s|/path/to/native-messaging-app/expose_home_folder_host.py|$FS_PY|" "$MANIFEST" > "$TMP_MANIFEST"

# Install to the user-level native messaging hosts directory
if [[ "$OSTYPE" == darwin* ]]; then
  DEST="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  DEST="$HOME/.mozilla/native-messaging-hosts"
fi

mkdir -p "$DEST"
cp "$TMP_MANIFEST" "$DEST/expose_home_folder_host.json"
rm "$TMP_MANIFEST"

echo "Installed native messaging manifest to: $DEST/expose_home_folder_host.json"
echo "Native app path set to:       $FS_PY"
