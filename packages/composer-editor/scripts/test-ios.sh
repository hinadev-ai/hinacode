#!/bin/sh
# Builds ios-tests/main.swift with the editor's layout code for the iOS simulator and runs it on a booted one.
# Needs Xcode and a booted simulator: `pnpm test:ios` from packages/composer-editor.
set -eu
cd "$(dirname "$0")/.."
device=$(xcrun simctl list devices booted -j | node -e 'const d=JSON.parse(require("fs").readFileSync(0)).devices;const b=Object.values(d).flat()[0];if(!b){console.error("Boot an iOS simulator first.");process.exit(1)}console.log(b.udid)')
out=$(mktemp -d)
trap 'rm -r "$out"' EXIT
xcrun --sdk iphonesimulator swiftc -target "$(uname -m)-apple-ios16.0-simulator" -O \
  ios/ChipLayoutManager.swift ios-tests/main.swift -o "$out/composer-editor-tests"
xcrun simctl spawn "$device" "$out/composer-editor-tests"
