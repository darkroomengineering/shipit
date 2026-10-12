#!/usr/bin/env bash
# Builds an Expo app's iOS archive with Xcode on this Mac and exports it or uploads it straight to App Store
# Connect, skipping any cloud build queue. `ship beta` calls this for ios.kind "expo"; it expects the clean
# worktree to hold node_modules already.
#
# Environment (set by ship):
#   SHIP_ROOT          the Expo project root, the folder that holds ios/ after prebuild
#   SHIP_SCHEME        Xcode scheme, which is also the app's folder inside ios/
#   SHIP_VERSION       marketing version
#   SHIP_BUILD_NUMBER  build number
#   SHIP_BUILD_DIR     where archives, exports and logs go
#   SHIP_UPLOAD        1 uploads to App Store Connect, 0 exports the archive locally
#   SHIP_KEY_FILE      App Store Connect API key (.p8)
#   ASC_KEY_ID, ASC_ISSUER_ID, APPLE_TEAM_ID
#   SHIP_PRE_ARCHIVE   optional executable run once the archive is built and before it is exported; it
#                      gets SHIP_ARCHIVE and SHIP_APP_BUNDLE
#
# Needs Xcode, CocoaPods and the team's Apple Distribution certificate in the login keychain. Xcode manages
# the provisioning profile through the API key.
set -euo pipefail
# Apple tar, not Homebrew GNU tar: Expo's prebuilt xcframework tarballs carry
# macOS metadata entries that GNU tar writes out as literal ._* files, which
# then get copied into the app's embedded frameworks. Expo extracts them both
# at pod install and in an Xcode build phase, so this covers the whole run.
export PATH="/usr/bin:$PATH"

ROOT="${SHIP_ROOT:?set SHIP_ROOT}"
BUILD_DIR="${SHIP_BUILD_DIR:?set SHIP_BUILD_DIR}"
SCHEME="${SHIP_SCHEME:?set SHIP_SCHEME}"
VERSION="${SHIP_VERSION:?set SHIP_VERSION}"
BUILD_NUMBER="${SHIP_BUILD_NUMBER:?set SHIP_BUILD_NUMBER}"
UPLOAD="${SHIP_UPLOAD:-0}"
KEY_FILE="${SHIP_KEY_FILE:?set SHIP_KEY_FILE}"
: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API key id)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect issuer id)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (the Apple team that owns the app)}"
[ -f "$KEY_FILE" ] || { echo "missing $KEY_FILE" >&2; exit 2; }

cd "$ROOT"
ARCHIVE="$BUILD_DIR/$SCHEME-$VERSION-$BUILD_NUMBER.xcarchive"
EXPORT_DIR="$BUILD_DIR/export-$VERSION-$BUILD_NUMBER"
mkdir -p "$BUILD_DIR"

echo "== prebuild ios/ from app.json"
bunx expo prebuild --platform ios --no-install >/dev/null
POD_INSTALL_LOG="$BUILD_DIR/pod-install.log"
(
  cd ios
  # Apple tar (PATH above) also keeps PAX diagnostics out of Expo's plist extraction stdout.
  RCT_BUILD_HERMES_FROM_SOURCE=true pod install > "$POD_INSTALL_LOG" 2>&1
) || {
  grep -E "(error:|\[!\]|Error|ERROR)" "$POD_INSTALL_LOG" | tail -20 >&2 || true
  echo "pod install failed; last 40 lines:" >&2
  tail -40 "$POD_INSTALL_LOG" >&2
  echo "full log at $POD_INSTALL_LOG" >&2
  exit 1
}
# Expo only re-extracts a missing xcframework, so ._* files left by an earlier
# GNU tar extraction survive pod install; clear them.
find ios/Pods -name '._*' -delete
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" \
  "ios/$SCHEME/Info.plist"

echo "== archive $VERSION ($BUILD_NUMBER)"
xcodebuild -workspace "ios/$SCHEME.xcworkspace" -scheme "$SCHEME" \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_FILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  > "$BUILD_DIR/archive.log" 2>&1 || {
    grep -E "error:" "$BUILD_DIR/archive.log" | head -20 >&2
    echo "archive failed; full log at $BUILD_DIR/archive.log" >&2
    exit 1
  }

APP_BUNDLE="$ARCHIVE/Products/Applications/$SCHEME.app"
ARCHIVED_BUILD_NUMBER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_BUNDLE/Info.plist")"
if [ "$ARCHIVED_BUILD_NUMBER" != "$BUILD_NUMBER" ]; then
  echo "archive build number is $ARCHIVED_BUILD_NUMBER; expected $BUILD_NUMBER" >&2
  exit 1
fi
STRAY_METADATA="$(find "$ARCHIVE" -name '._*' | head -5)"
if [ -n "$STRAY_METADATA" ]; then
  printf '%s\n' "$STRAY_METADATA" >&2
  echo "archive contains ._* metadata files; App Store validation rejects them in embedded frameworks" >&2
  exit 1
fi

if [ -n "${SHIP_PRE_ARCHIVE:-}" ]; then
  echo "== preArchive hook"
  SHIP_ARCHIVE="$ARCHIVE" SHIP_APP_BUNDLE="$APP_BUNDLE" "$SHIP_PRE_ARCHIVE"
fi

FRAMEWORKS_DIR="$APP_BUNDLE/Frameworks"
HERMES_BINARY="$FRAMEWORKS_DIR/hermesvm.framework/hermesvm"
if [ -f "$HERMES_BINARY" ]; then
  echo "== verify Hermes minimum iOS metadata"
  python3 -I - "$HERMES_BINARY" <<'PY'
import pathlib
import plistlib
import re
import subprocess
import sys

binary = pathlib.Path(sys.argv[1])
build = subprocess.check_output(["xcrun", "vtool", "-show-build", str(binary)], text=True)
platforms = re.findall(r"^\s*platform (\S+)\s*$", build, re.MULTILINE)
versions = re.findall(r"^\s*minos (\d+(?:\.\d+){1,2})\s*$", build, re.MULTILINE)
if not platforms or set(platforms) != {"IOS"} or len(versions) != len(platforms) or len(set(versions)) != 1:
    raise SystemExit("Cannot determine a single iOS deployment target for Hermes")
minimum = versions[0]
path = binary.parent / "Info.plist"
info = plistlib.loads(path.read_bytes())
if not info.get("MinimumOSVersion"):
    # CMake can omit this metadata; use the compiled binary's deployment target.
    info["MinimumOSVersion"] = minimum
    path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
if info["MinimumOSVersion"] != minimum:
    raise SystemExit("Hermes MinimumOSVersion does not match its compiled deployment target")
print(f"Hermes MinimumOSVersion verified: {minimum}")
PY
  HERMES_DSYM="$ARCHIVE/dSYMs/hermesvm.framework.dSYM"
  HERMES_DSYM_LOG="$BUILD_DIR/hermes-dsym-$BUILD_NUMBER.log"
  mkdir -p "$ARCHIVE/dSYMs"
  echo "== generate Hermes dSYM"
  if ! xcrun dsymutil "$HERMES_BINARY" -o "$HERMES_DSYM" \
    > "$HERMES_DSYM_LOG" 2>&1; then
    tail -40 "$HERMES_DSYM_LOG" >&2
    echo "Hermes dSYM generation failed; full log at $HERMES_DSYM_LOG" >&2
    exit 1
  fi
  if grep -qi "no debug symbols" "$HERMES_DSYM_LOG"; then
    tail -40 "$HERMES_DSYM_LOG" >&2
    echo "Hermes binary contains no debug symbols; refusing to export" >&2
    exit 1
  fi
else
  echo "hermesvm.framework is absent; treating Hermes as source/static"
fi

# App Store Connect rejects uploads whose embedded frameworks lack matching dSYMs.
echo "== verify embedded framework dSYM coverage"
DSYM_UUIDS="$BUILD_DIR/dsym-uuids-$BUILD_NUMBER.log"
: > "$DSYM_UUIDS"
while IFS= read -r -d '' DWARF_BINARY; do
  DWARF_UUID_OUTPUT="$(xcrun dwarfdump --uuid "$DWARF_BINARY")" || {
    echo "could not read dSYM UUIDs from $DWARF_BINARY" >&2
    exit 1
  }
  printf '%s\n' "$DWARF_UUID_OUTPUT" \
    | awk '/^UUID: / { print toupper($2) }' >> "$DSYM_UUIDS"
done < <(find "$ARCHIVE/dSYMs" -type f -path '*/Contents/Resources/DWARF/*' -print0)

for FRAMEWORK_SPEC in \
  "React.framework:React" \
  "ReactNativeDependencies.framework:ReactNativeDependencies" \
  "hermesvm.framework:hermesvm"; do
  FRAMEWORK_NAME="${FRAMEWORK_SPEC%%:*}"
  BINARY_NAME="${FRAMEWORK_SPEC#*:}"
  FRAMEWORK_BINARY="$FRAMEWORKS_DIR/$FRAMEWORK_NAME/$BINARY_NAME"
  if [ ! -f "$FRAMEWORK_BINARY" ]; then
    echo "$FRAMEWORK_NAME is absent; treating it as source/static"
    continue
  fi

  FRAMEWORK_UUID_OUTPUT="$(xcrun dwarfdump --uuid "$FRAMEWORK_BINARY")" || {
    echo "could not read framework UUIDs from $FRAMEWORK_BINARY" >&2
    exit 1
  }
  FRAMEWORK_UUIDS="$(printf '%s\n' "$FRAMEWORK_UUID_OUTPUT" \
    | awk '/^UUID: / { print toupper($2) }')"
  if [ -z "$FRAMEWORK_UUIDS" ]; then
    echo "no UUIDs found for $FRAMEWORK_NAME" >&2
    exit 1
  fi

  while IFS= read -r FRAMEWORK_UUID; do
    if ! grep -Fxq "$FRAMEWORK_UUID" "$DSYM_UUIDS"; then
      echo "missing dSYM UUID $FRAMEWORK_UUID for $FRAMEWORK_NAME" >&2
      exit 1
    fi
  done <<< "$FRAMEWORK_UUIDS"
  echo "$FRAMEWORK_NAME dSYM coverage verified"
done

DESTINATION="export"
[ "$UPLOAD" = 1 ] && DESTINATION="upload"
OPTIONS="$BUILD_DIR/export-options.plist"
cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DESTINATION</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

echo "== $DESTINATION"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$OPTIONS" -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_FILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  > "$BUILD_DIR/export.log" 2>&1 || {
    grep -E "error:" "$BUILD_DIR/export.log" | head -20 >&2
    echo "$DESTINATION failed; full log at $BUILD_DIR/export.log" >&2
    exit 1
  }

if [ "$UPLOAD" = 1 ]; then
  echo "uploaded $VERSION ($BUILD_NUMBER); TestFlight lists it after Apple's processing"
else
  echo "exported to $EXPORT_DIR"
fi
