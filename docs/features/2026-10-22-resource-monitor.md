# Resource monitor

Status: Building
Date: 2026-10-22

## Problem

HinaCode starts many processes: agent CLIs, app servers, terminals, setup scripts, and whatever those run. Two kinds of leak cost a developer here, and neither shows up in tests that finish in seconds.

- A process outlives the thread or the app that started it. A dev server started in a terminal, an MCP server, or a daemon an agent forked keeps running after HinaCode quits.
- A process grows for as long as the app runs. A retained listener or cache in main or the renderer adds megabytes an hour.

This is a development tool. Packaged builds do not run it.

## User flow

1. `pnpm dev` builds the monitor when Go is installed and prints one line when it skips the build.
2. The app starts the monitor next to itself and prints where it logs. Each run gets its own log in `<userData>/resource-monitor/`.
3. When the app quits, the monitor waits a few seconds, takes a last sample, and prints any process that outlived HinaCode to the terminal that ran `pnpm dev`.
4. `pnpm resource-monitor report <log or directory>` prints what outlived the app, what kept growing, and the largest processes. It exits 1 when a process outlived the app or kept growing, so a script or test can fail on it.

## Design

A Go binary in `tools/resource-monitor` with two commands.

`watch -root <pid> -instance <id> -out <file>` samples every 5 seconds until the root process is gone, then waits 3 seconds and writes a final sample. It tracks two sets of processes:

- every descendant of the root, walked from the parent pids each sample. A child counts only when it started after its parent, so a reused pid does not adopt strangers.
- every process whose environment has `HINACODE_INSTANCE=<id>`. The app sets that variable on itself at startup to a new random id, so everything it spawns inherits it, including a daemon that double-forks and is reparented to init before any sample sees it. The id changes per launch, so after a quick restart the new run does not count the last run's processes while they shut down. The monitor reads each process's environment once and caches the answer. The OS fixes that environment at exec, and only the root can exec a process into the tag, so the answer holds for the process's life.

A process in the second set but not the first is detached, which is how an orphan looks while the app still runs. Zombies, exited processes their parent has not reaped yet, are left out.

The memory number is not RSS:

| OS    | Metric           | Source                                               |
| ----- | ---------------- | ---------------------------------------------------- |
| Linux | PSS              | `/proc/<pid>/smaps_rollup`                           |
| macOS | `phys_footprint` | `proc_pid_rusage`, called through purego without cgo |
| other | RSS              | gopsutil                                             |

RSS counts a page shared by several Chromium and Node processes once in each of them. On macOS it also leaves out compressed memory, so a leaking process that the OS compresses looks flat. The report prints MB as 2^20 bytes.

Each log line is one sample:

```json
{
  "at": "2026-10-22T09:15:04.120Z",
  "root": 41230,
  "memory": "pss",
  "final": false,
  "processes": [
    {
      "pid": 41230,
      "ppid": 41190,
      "startedAt": 1792660401000,
      "name": "electron",
      "role": "main",
      "command": "electron out/main/index.js",
      "attached": true,
      "cpuSeconds": 12.4,
      "memoryBytes": 312475648
    }
  ]
}
```

`pid` and `startedAt` together identify a process. `role` is `main` for the root, the Chromium `--type=` value for Electron helpers, and empty otherwise. `cpuSeconds` is cumulative, so the report derives CPU use from differences and a missed sample loses nothing.

`report` is a pure function of the log:

- Outlived the app. A process detached in the log's last sample. When that sample is final, it is still running after the app quit. When the app still runs, it is orphaned right now. A process that was orphaned for a while and then exited is not a leak.
- Growing. A Theil–Sen slope of memory over time, ignoring each process's first 2 minutes and skipping processes seen for under 10 minutes. It flags slopes above 50 MB per hour. Theil–Sen takes the median of pairwise slopes, so a GC pause or a one-off spike does not move it. The thresholds are guesses to tune after real use.

The app side is `src/main/resourceMonitor.ts`. In an unpackaged run, when the binary exists, it sets `HINACODE_INSTANCE` and spawns `watch` detached, with stderr inherited. Detached keeps Ctrl+C in the `pnpm dev` terminal from killing the monitor before its final sample.

An editor opened through Open with drops the tag, because it outlives the app by design. On Linux, a browser that a link starts through `xdg-open` still inherits it, and shows up as outliving the app when it was not already running.

## Out of scope

- Packaged builds, `hinacode serve`, and Windows. Packaging a binary means signing and notarizing it, and nothing here needs to reach users yet.
- Attributing processes to threads. Codex and Muse share one app server per account across threads, so an environment tag per thread would be wrong for them.
- JavaScript heap leaks too small to see in process memory. The renderer leak from `@formkit/auto-animate` grew by about 0.1 MB per round. A CDP probe that counts DOM nodes and listeners after forced GC finds those.
- A UI. The log and the report are the interface.

## Verification

- `go test ./...` in `tools/resource-monitor` starts real processes: a child of the test, a tagged daemon that double-forks away, an untagged one, and an unreaped zombie. It checks which are tracked and detached, runs `watch` on a root that exits once the first sample is written, and checks that `report` exits 1 for the survivor. CI runs it on Linux and on the macOS runner.
- Run `pnpm dev`, open a terminal in a thread, run `nohup sleep 600 >/dev/null 2>&1 &`, and quit the app. The `pnpm dev` terminal prints the surviving `sleep`, and `pnpm resource-monitor report <userData>/resource-monitor` lists it and exits 1. A plain `sleep 600 &` is not reported, because the shell hangs it up when its terminal closes.
