#!/bin/sh
# Ad-hoc signs and zips the macOS build made on Linux. Apple Silicon refuses to run unsigned binaries.
# Needs rcodesign: https://github.com/indygreg/apple-platform-rs/releases
set -eu
version=$(node -p 'require("./package.json").version')
cd dist/mac-arm64
rcodesign sign kkcode.app
rm -f "../kkcode-$version-arm64-mac.zip"
zip -qry "../kkcode-$version-arm64-mac.zip" kkcode.app
