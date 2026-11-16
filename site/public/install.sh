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

  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    fail "run this without sudo. Under sudo the cloud and its service would belong to root, not $SUDO_USER."
  fi

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=darwin-arm64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) target=linux-arm64 ;;
    Darwin-x86_64)
      [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ] || no_build
      target=darwin-arm64
      ;;
    *) no_build ;;
  esac
  command -v curl >/dev/null || fail "curl is missing"
  command -v tar >/dev/null || fail "tar is missing"
  command -v sha256sum >/dev/null || command -v shasum >/dev/null || fail "sha256sum or shasum is missing"

  mkdir -p "$install_dir/versions" "$bin_dir"
  staging="$(mktemp -d "$install_dir/.download.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT

  local archive="hinacode-$target.tar.gz"
  echo "Downloading $archive"
  curl -fSL --progress-bar -o "$staging/$archive" "$release_url/$archive"
  curl -fsSL -o "$staging/$archive.sha256" "$release_url/$archive.sha256" || fail "could not download $archive.sha256"
  local expected actual
  expected="$(cut -d ' ' -f 1 "$staging/$archive.sha256")"
  actual="$(sha256 "$staging/$archive")"
  [ "$expected" = "$actual" ] || fail "$archive does not match its checksum. Nothing was installed."
  tar -xzf "$staging/$archive" -C "$staging"

  local version
  version="$("$staging/hinacode/hinacode" --version)" || fail "the downloaded hinacode does not run on this machine"
  version="${version##* }"
  [ -n "$version" ] || fail "the downloaded hinacode did not report its version"
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

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi | cut -d ' ' -f 1
}

no_build() {
  fail "there is no build for $(uname -s) $(uname -m). With Node 24, run: npm install -g --allow-scripts=node-pty hinacode"
}

fail() {
  echo "hinacode install: $*" >&2
  exit 1
}

main "$@"
