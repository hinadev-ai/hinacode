# Ports

The thread details panel lists TCP ports that are listening from processes started in the thread's workspace or spawned by its agent, refreshed every 2 seconds, each with a two-click kill button. This catches dev servers an agent started and forgot.

## Automated coverage

`e2e/features/ports.feature`: a listener whose working directory is the workspace appears with its pid, the arm-then-stop button kills it and the region returns to `No open ports`, and a listener running elsewhere is not attributed to the thread.

## Sub-features

- `list`, `scope`, `kill-arm`, `kill`, `empty` (e2e).
- `list-agent` a listener spawned by the thread's agent appears even if its cwd is elsewhere.

## How to get to it (user POV)

- Open a thread, show the panel (`Ctrl+.`), region `Ports`.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, a Claude thread (`Sonnet 5.5`) in project `demo`, open with the panel visible. This costs one turn.
- `AB="agent-browser --session kkv-$PORT-ports"`, connected.

- **Agent-spawned listener.** Send `Use the Bash tool to run in the background from /tmp: python3 -m http.server 0 --bind 127.0.0.1`, `Allow` it. Within a few seconds the `Ports` region lists the port with `python3 (pid …)` although its cwd is `/tmp`. Screenshot `ports-01-agent-listener.png`. Stop it from the panel; the row disappears.

## Gotchas

- `python3 -m http.server` shows as `python3` and Node servers as `node` or `node-MainThread`: the row uses `/proc/<pid>/comm`.
- The arm state resets when the button loses focus. Do not click or focus anything else between the two clicks.
