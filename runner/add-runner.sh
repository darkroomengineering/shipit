#!/bin/bash
# Usage: sudo RUNNER_TOKEN=... ./add-runner.sh <name> <labels>
# Clones an existing runner install, registers it, and starts it as a login
# LaunchAgent in runner's GUI session (no SessionCreate, so the keychain works).
set -euo pipefail
NAME="$1"
LABELS="$2"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
ORG_URL="https://github.com/darkroomengineering"
GROUP="macbook-private"
BASE=/Users/runner/actions-runner
SRC="$BASE/studio-ci"
DST="$BASE/$NAME"
RUID=$(id -u runner)
AGENTS=/Users/runner/Library/LaunchAgents
LABEL="actions.runner.darkroomengineering.$NAME"
PLIST="$AGENTS/$LABEL.plist"

if [ -e "$DST" ]; then echo "$DST already exists" >&2; exit 1; fi

sudo -u runner mkdir "$DST"
sudo -u runner rsync -a \
  --exclude _work --exclude _diag --exclude '.runner*' --exclude '.credentials*' \
  --exclude .service --exclude .env --exclude .path "$SRC/" "$DST/"

cd "$DST"
sudo -u runner ./config.sh --unattended --url "$ORG_URL" --token "$RUNNER_TOKEN" \
  --name "$NAME" --labels "$LABELS" --runnergroup "$GROUP" --work _work
sudo -u runner cp "$SRC/.path" "$DST/.path"

sudo -u runner mkdir -p "/Users/runner/Library/Logs/$LABEL"
sed "s/studio-ci/$NAME/g" "$AGENTS/actions.runner.darkroomengineering.studio-ci.plist" > "$PLIST"
chown runner:staff "$PLIST"
plutil -lint "$PLIST"
if plutil -extract SessionCreate raw "$PLIST" >/dev/null 2>&1; then plutil -remove SessionCreate "$PLIST"; fi
echo "$PLIST" | sudo -u runner tee "$DST/.service" >/dev/null

launchctl bootstrap "gui/$RUID" "$PLIST"
echo "started $NAME"
