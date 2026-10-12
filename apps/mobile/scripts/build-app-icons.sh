#!/usr/bin/env sh
# Renders the app icons from the desktop's assets/icon.svg so both apps share one mark.
# Needs rsvg-convert (librsvg). Run from apps/mobile and commit the result.
set -eu
out=assets/images
glyph='<text x="512" y="512" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="512" font-weight="600" fill="FILL">K</text>'
svg() { printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">%s</svg>' "$1"; }

svg "<rect width=\"1024\" height=\"1024\" fill=\"#7c3aed\"/>$(echo "$glyph" | sed s/FILL/#ffffff/)" | rsvg-convert -w 1024 -o "$out/icon.png"
svg "<rect width=\"1024\" height=\"1024\" fill=\"#7c3aed\"/>" | rsvg-convert -w 1024 -o "$out/android-icon-background.png"
svg "$(echo "$glyph" | sed s/FILL/#ffffff/)" | rsvg-convert -w 1024 -o "$out/android-icon-foreground.png"
svg "$(echo "$glyph" | sed s/FILL/#ffffff/)" | rsvg-convert -w 1024 -o "$out/android-icon-monochrome.png"
svg "<rect width=\"1024\" height=\"1024\" rx=\"224\" fill=\"#7c3aed\"/>$(echo "$glyph" | sed s/FILL/#ffffff/)" | rsvg-convert -w 200 -o "$out/splash-icon.png"
svg "<rect width=\"1024\" height=\"1024\" rx=\"224\" fill=\"#7c3aed\"/>$(echo "$glyph" | sed s/FILL/#ffffff/)" | rsvg-convert -w 64 -o "$out/favicon.png"
