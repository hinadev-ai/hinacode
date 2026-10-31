#!/usr/bin/env sh
# Renders every app icon from the desktop's assets/icon.svg so both apps share one mark.
# Needs rsvg-convert (librsvg). Run with `pnpm build:icons` and commit the result.
set -eu
cd "$(dirname "$0")/.."
src=../../assets/icon.svg
out=assets/images

# iOS masks the icon itself and rejects transparent corners, so drop the tile's rounding.
sed 's/ rx="[^"]*"//' "$src" | rsvg-convert -w 1024 -o "$out/icon.png"
sed 's/ rx="[^"]*"//; /<g /d' "$src" | rsvg-convert -w 1024 -o "$out/android-icon-background.png"

# Android crops adaptive layers to a 66dp circle of the 108dp canvas. A pill cap reaches 86.2 units
# from the centre, so a 288-unit viewBox keeps the mark inside: 86.2 / 288 < 33 / 108.
mark() { sed '/<rect /d; s/viewBox="[^"]*"/viewBox="-16 -16 288 288"/' "$src"; }
mark | rsvg-convert -w 1024 -o "$out/android-icon-foreground.png"
mark | rsvg-convert -w 1024 -o "$out/android-icon-monochrome.png"

rsvg-convert -w 1024 -o "$out/splash-icon.png" "$src"
rsvg-convert -w 64 -o "$out/favicon.png" "$src"
