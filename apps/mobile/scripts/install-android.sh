#!/usr/bin/env sh
# Builds a standalone Release APK from this checkout and installs it on the phone adb sees.
# Run with `pnpm install:android`. Pass an adb serial as the first argument when several devices are attached.
set -eu
cd "$(dirname "$0")/.."

if [ -z "${JAVA_HOME:-}" ]; then
  for jdk in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@17; do
    [ -x "$jdk/bin/java" ] && export JAVA_HOME="$jdk" && break
  done
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

# android/ is generated and ignored, so regenerate it to pick up new native modules, icons and app.json changes.
# Prebuild also rewrites app.json and package.json for a bare workflow, so put them back.
tmp=$(mktemp -d)
cp app.json package.json "$tmp"
trap 'cp "$tmp/app.json" "$tmp/package.json" . && rm -rf "$tmp"' EXIT
CI=1 npx expo prebuild --platform android --clean --no-install
echo "sdk.dir=$ANDROID_HOME" >android/local.properties

(cd android && ./gradlew :app:assembleRelease)
apk=android/app/build/outputs/apk/release/app-release.apk

# The phone talks to the desktop over plain ws://, which Release builds block unless the manifest opts in.
# Without it the app installs fine and then sits on "Reconnecting" forever, so refuse to install it.
aapt2="$(ls -d "$ANDROID_HOME"/build-tools/*/ | tail -1)aapt2"
if ! "$aapt2" dump xmltree --file AndroidManifest.xml "$apk" | grep -q 'usesCleartextTraffic.*=true'; then
  echo "The APK blocks cleartext traffic, so it cannot reach the desktop. Check expo-build-properties in app.json." >&2
  exit 1
fi

adb ${1:+-s "$1"} install -r "$apk"
adb ${1:+-s "$1"} shell am start -n com.hinadev.hinacode/.MainActivity >/dev/null
