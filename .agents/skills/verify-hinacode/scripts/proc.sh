# Sourced by launch.sh, doctor.sh, stop.sh and cleanup.sh. Linux tracks an instance by its session id.
# macOS has no setsid(1), `pgrep -s`, `ss` or /proc, so there the instance is its leader's process group
# plus every descendant, which also catches agents that move into a session of their own.

is_mac() { [[ "$(uname -s)" == Darwin ]]; }

new_session() {
  if is_mac; then perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!\n"; exec @ARGV or die "exec: $!\n"' "$@"
  else setsid "$@"; fi
}

descendants() {
  local child
  for child in $(pgrep -P "$1"); do echo "$child"; descendants "$child"; done
}

session_pids() {
  if is_mac; then { pgrep -g "$1"; ps -p "$1" -o pid= | tr -d ' '; descendants "$1"; } | sort -u | grep .
  else pgrep -s "$1"; fi
}

session_alive() { session_pids "$1" >/dev/null; }

in_session() { session_pids "$2" | grep -qx "$1"; }

port_holders() {
  if is_mac; then lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
  else ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u; fi
}

port_in_use() {
  if is_mac; then [[ -n "$(port_holders "$1")" ]]
  else ss -ltnH "sport = :$1" | grep -q .; fi
}

signal_session() {
  local pids
  pids=$(session_pids "$2") || return 1
  kill "-$1" $pids 2>/dev/null
}
