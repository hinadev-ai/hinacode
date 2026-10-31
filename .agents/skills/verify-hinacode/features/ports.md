# Ports

The thread details panel lists TCP ports that are listening from processes started in the thread's workspace, by the thread's Claude Code CLI, or by a terminal opened in the thread, refreshed every 2 seconds, each with a two-click kill button. This catches dev servers an agent started and forgot.

## Automated coverage

`e2e/features/ports.feature`: a listener whose working directory is the workspace appears with its pid, the arm-then-stop button kills it and the region returns to `No open ports`, and a listener running elsewhere is not attributed to the thread.

## Sub-features

- `list`, `scope`, `kill-arm`, `kill`, `empty` (e2e).
- `list-terminal` a listener started from the thread's terminal appears even if its cwd is elsewhere.
- `list-agent` a listener spawned by the thread's Claude Code CLI appears even if its cwd is elsewhere. Codex and Muse Code register no pids, so theirs only show by cwd.

## How to get to it (user POV)

- Open a thread; the panel is open by default (`Ctrl+.` hides and shows it). Tab `Details`, region `Ports`.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, a thread in project `demo` open with the panel on `Details`. No turn is needed except for `list-agent`.
- `AB="agent-browser --session kkv-$PORT-ports"`, connected.

- **Terminal-spawned listener.** `$S/rpc.ts $PORT terminal.open '{"threadId":"<id>","cols":80,"rows":24}'`, then `terminal.write` with `{"id":"<session id>","data":"cd /tmp && python3 -m http.server 0 --bind 127.0.0.1\r"}`. Within a few seconds `Ports` lists the port with `python3 (pid …)` although its cwd is `/tmp`. Screenshot `ports-01-terminal-listener.png`. Click `Stop python3 on port <port>` twice in a row; the row disappears.
- **Agent-spawned listener.** On a Claude thread (`Sonnet 5.5`, one turn), send `Use the Bash tool to run in the background from /tmp: python3 -m http.server 0 --bind 127.0.0.1`. The port appears the same way. Screenshot `ports-02-agent-listener.png`. Stop it from the panel.

## Gotchas

- `python3 -m http.server` shows as `python3` and Node servers as `node` or `node-MainThread`: the name comes from `/proc/<pid>/stat`.
- The arm state resets when the button loses focus. Do not click or focus anything else between the two clicks.
- A server started with `python3 -m http.server` straight from your shell in `/tmp` is not the thread's and must not appear; one started in `$DATA/repo` must.
