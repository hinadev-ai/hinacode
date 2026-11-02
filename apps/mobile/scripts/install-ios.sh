#!/usr/bin/env sh
# Builds a standalone Release app from this checkout and installs it on the iPhone or iPad devicectl sees.
# Run with `pnpm install:ios`. Pass a device UDID as the first argument when several devices are connected.
set -eu
cd "$(dirname "$0")/.."

# CocoaPods on Ruby 4 crashes in String#unicode_normalize unless the locale is UTF-8.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

device=${1:-}
if [ -z "$device" ]; then
  devices=$(mktemp)
  xcrun devicectl list devices --json-output "$devices" >/dev/null
  device=$(node -e '
    const connected = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).result.devices.filter(
      (d) => d.hardwareProperties.reality === "physical" && d.connectionProperties.tunnelState === "connected",
    )
    if (connected.length !== 1) {
      console.error(`Found ${connected.length} connected devices. Pass a UDID from \`xcrun devicectl list devices\`.`)
      process.exit(1)
    }
    console.log(connected[0].hardwareProperties.udid)
  ' "$devices")
  rm "$devices"
fi

# ios/ is generated and ignored, so regenerate it to pick up new native modules, icons and app.json changes.
# Prebuild also rewrites app.json and package.json for a bare workflow, so put them back.
tmp=$(mktemp -d)
cp app.json package.json "$tmp"
trap 'cp "$tmp/app.json" "$tmp/package.json" . && rm -rf "$tmp"' EXIT
CI=1 npx expo prebuild --platform ios --clean

xcodebuild -workspace ios/HinaCode.xcworkspace -scheme HinaCode -configuration Release \
  -destination "id=$device" -derivedDataPath ios/build -allowProvisioningUpdates -quiet build

xcrun devicectl device install app --device "$device" ios/build/Build/Products/Release-iphoneos/HinaCode.app
xcrun devicectl device process launch --device "$device" --terminate-existing com.hinadev.hinacode >/dev/null
