# Ports

The thread details panel lists TCP ports that are listening from processes started in the thread's workspace, by the thread's Claude Code CLI, or by a terminal opened in the thread, refreshed every 2 seconds, each with a two-click kill button. This catches dev servers an agent started and forgot.

## Automated coverage

`e2e/features/ports.feature`: a listener whose working directory is the workspace appears with its pid, the arm-then-stop button kills it and the region returns to `No open ports`, and a listener running elsewhere is not attributed to the thread.

## Sub-features

- `list`, `scope`, `kill-arm`, `kill`, `empty` (e2e).
- `list-terminal` a listener started from the thread's terminal appears even if its cwd is elsewhere.
- `list-agent` a listener spawned by the thread's Claude Code CLI appears even if its cwd is elsewhere. Codex and Muse Code register no pids, so theirs only show by cwd.

## How to get to it (user POV)

- Open a thread; the side panel is open by default in a wide window (`Mod+.` hides and shows it) and reopens on its last tab. Click tab `Details` (`Mod+Shift+O`), region `Ports`.
- `New terminal` (`Mod+J`) opens the thread's terminal.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, a thread in project `demo` open with the panel on `Details`. No turn is needed except for `list-agent`.
- `ab() { agent-browser --session kkv-$PORT-ports --cdp $PORT "$@"; }`.

- **Terminal-spawned listener.** `$S/rpc.ts $PORT terminal.open '{"threadId":"<id>","cols":80,"rows":24}'`, then `terminal.write` with `{"id":"<session id>","data":"python3 -m http.server 48765 --bind 127.0.0.1\r"}`. `ab find role tab click --name "Details" --exact`, `ab wait 'button[aria-label^="Stop "]' --timeout 15000`: `Ports` lists `Stop Python on port 48765` (macOS; `python3` on Linux). Screenshot `ports-01-terminal-listener.png`. `ab focus 'button[aria-label^="Stop Python"]'`, `ab press Enter`, `ab wait 'button[aria-label^="Click again to stop"]'`, `ab press Enter`, `ab wait --text "No open ports"`. `lsof -nP -iTCP:48765 -sTCP:LISTEN` (or `ss -ltn` on Linux) prints nothing.
- **Agent-spawned listener.** On a Claude thread (`Sonnet 5.5`, one turn), send `Use the Bash tool to run in the background from /tmp: python3 -m http.server 0 --bind 127.0.0.1`. The port appears the same way. Screenshot `ports-02-agent-listener.png`. Stop it from the panel.

## Gotchas

- On Linux the name comes from `/proc/<pid>/stat`: `python3`, `node` or `node-MainThread`. On macOS it comes from `lsof +c 0`, so a Homebrew or framework Python shows as `Python`.
- After the first press the button is renamed `Click again to stop <command>`, so a second `find --name "Stop …"` misses. Keep focus on it and press `Enter` again. The arm state resets when the button loses focus.
- A server started with `python3 -m http.server` straight from your shell in `/tmp` is not the thread's and must not appear; one started in `$DATA/repo` must.
