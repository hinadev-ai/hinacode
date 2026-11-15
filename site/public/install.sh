#!/usr/bin/env bash
# Installs the HinaCode cloud, `hinacode serve` without Node or a window, and keeps it running as a service.
#   curl -fsSL https://hinacode.app/install.sh | bash
# HINACODE_RELEASE_URL picks another release, such as https://github.com/hinadev-ai/hinacode/releases/download/v0.3.0
set -euo pipefail

main() {
  local release_url="${HINACODE_RELEASE_URL:-https://github.com/hinadev-ai/hinacode/releases/latest/download}"
  local install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/hinacode"
  local bin_dir="$HOME/.local/bin"
  local target

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=darwin-arm64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) target=linux-arm64 ;;
    *) fail "there is no build for $(uname -s) $(uname -m). With Node 24, run: npm install -g --allow-scripts=node-pty hinacode" ;;
  esac
  command -v curl >/dev/null || fail "curl is missing"
  command -v tar >/dev/null || fail "tar is missing"

  mkdir -p "$install_dir/versions" "$bin_dir"
  staging="$(mktemp -d "$install_dir/.download.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT

  echo "Downloading hinacode-$target.tar.gz"
  curl -fSL --progress-bar "$release_url/hinacode-$target.tar.gz" | tar -xz -C "$staging"

  local version
  version="$("$staging/hinacode/hinacode" --version)" || fail "the downloaded hinacode does not run on this machine"
  version="${version##* }"
  local current="$install_dir/versions/$version"
  rm -rf "$current"
  mv "$staging/hinacode" "$current"
  ln -sfn "$current/hinacode" "$bin_dir/hinacode"
  echo "Installed hinacode $version to $bin_dir/hinacode"
  echo

  "$bin_dir/hinacode" connect

  local old
  for old in "$install_dir/versions"/*; do
    [ "$old" = "$current" ] || rm -rf "$old"
  done

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf '\nAdd %s to your PATH to run hinacode from any shell:\n  export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir" ;;
  esac
}

fail() {
  echo "hinacode install: $*" >&2
  exit 1
}

main "$@"
