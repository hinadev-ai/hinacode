# Ports

The thread details panel lists TCP ports that are listening from processes started in the thread's workspace or spawned by its agent, refreshed every 2 seconds, each with a two-click kill button. This catches dev servers an agent started and forgot. No agent turn is needed: a process whose working directory is inside the workspace counts.

## Sub-features

- `list` a listener whose cwd is in the workspace appears as `<port>` with `<command> (pid <pid>)` within a few seconds.
- `list-agent` a listener spawned by the thread's agent appears even if its cwd is elsewhere.
- `scope` listeners from other directories do not appear.
- `kill-arm` the first click on `Stop <command> on port <port>` arms the button; its label becomes `Click again to stop <command>`.
- `kill` the second click stops the process and the row disappears.
- `empty` the region reads `No open ports` when nothing listens.

## How to get to it (user POV)

- Open a thread, show the panel (`Show thread details` or `Ctrl+.`), region `Ports`.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo`, a thread in it open with the panel visible. The `Ports` region reads `No open ports`.
- `AB="agent-browser --session kkv-$PORT-ports"`, connected.

- **Start a listener in the workspace.** `(cd $DATA/repo && setsid python3 -m http.server 0 --bind 127.0.0.1 >$DATA/http.log 2>&1 & echo $! > $DATA/http.pid)`. Find its port with `ss -ltnpH | grep "pid=$(cat $DATA/http.pid)"`.
- **Listed.** Within about 2 seconds the `Ports` region shows that port and `python3 (pid <pid>)`. Screenshot `ports-01-listed.png`.
- **Scope.** A listener started from `/tmp` (`(cd /tmp && python3 -m http.server 0 --bind 127.0.0.1 &)`) does not appear. Stop it yourself afterwards by pid.
- **Arm.** `$AB find role button click --name "Stop python3 on port <port>" --exact`. The button's name becomes `Click again to stop python3`. Screenshot `ports-02-armed.png`.
- **Kill.** Click it again (`find role button click --name "Click again to stop python3" --exact`). The row disappears and the region reads `No open ports`. Screenshot `ports-03-killed.png`. `kill -0 $(cat $DATA/http.pid)` fails.

## Gotchas

- Start test servers with `setsid` from your own shell, not from the app's session, and kill them by recorded pid if the UI kill fails. `cleanup.sh` only stops the app's session.
- `python3 -m http.server` shows as `python3` because the row uses `/proc/<pid>/comm`.
- The arm state resets when the button loses focus. Do not click or focus anything else between the two clicks.
- `list-agent` needs a real agent turn (`Use the Bash tool to run: python3 -m http.server 0 &` from `/tmp`); treat it as optional and costly.
