#!/usr/bin/env sh
# Runs a command with JAVA_HOME and ANDROID_HOME set to the usual macOS locations when they are unset.
set -eu

if [ -z "${JAVA_HOME:-}" ]; then
  for jdk in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@17; do
    [ -x "$jdk/bin/java" ] && export JAVA_HOME="$jdk" && break
  done
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

exec "$@"
