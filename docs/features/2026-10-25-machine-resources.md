# Machine resources

Status: Building
Date: 2026-10-25

## Problem

A developer runs agents on this machine and on paired clouds (`2026-10-15-desktop-environments.md`). When a turn slows down or a build fails with `ENOSPC`, the cause is often the machine: six agents compiling at once, memory pushed into swap, or worktrees and `node_modules` filling the disk. Today the only way to see that on a cloud is to SSH in and run `top` and `df`.

## User flow

1. The title bar has a gauge button next to Settings. Clicking it, or running **Show machine resources** from the command palette, opens a popover.
2. The popover lists this machine first, then each paired cloud. Each row shows CPU and memory over the last 10 minutes as a sparkline with the current value, and every disk HinaCode writes to as a bar. Under each value is its detail: the 1-minute load average and the core count, memory in GB, and free space. Under the name, the row says how many agents are working there.
3. CPU, memory and disk turn amber at 90%.
4. A cloud that is not connected shows its state instead of numbers, in the words the sidebar uses. A cloud on an older HinaCode says to update it.
5. Escape or a click outside closes the popover, and polling stops.

## Design

Every HinaCode process, desktop or `hinacode serve`, samples its own machine. The desktop asks each environment for its samples over the connection it already has.

We considered Prometheus with `node_exporter`, and the `systeminformation` package. Prometheus needs an exporter and a scraper on every machine, a port open between them, and a second credential beside the cloud token. `systeminformation` shells out to `vm_stat`, `df` and others for numbers Node already has. Node's built-ins cover all four:

| Metric | Source                                              | Notes                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU    | `os.cpus()` times, difference between two samples   | Share of all cores busy. In a container this is the host's, since `/proc/stat` ignores the CPU quota.                                                                                                                                                     |
| Memory | `os.totalmem() - process.availableMemory()`         | libuv 1.52 counts free, inactive and purgeable pages on macOS, `MemAvailable` on Linux. In a container with a memory limit, the limit is the total and its page cache counts as used. `os.freemem()` counts free pages only on macOS and reads near 100%. |
| Load   | `os.loadavg()[0]`                                   | Windows has none. It reports `null`.                                                                                                                                                                                                                      |
| Disk   | `fs.statfs` on the home directory and project roots | Paths on one device (`stat().dev`) count once. Used is `blocks - bfree` and free is `bavail`, as `df` reports them. On APFS that is the whole container.                                                                                                  |

`services/SystemResources.ts` forks a fiber that samples every 5 seconds and keeps the last 120 samples, 10 minutes. CPU and memory history is ready the moment the popover opens. `read` stats the disks on each request, since they change slowly and depend on the project list.

```ts
ResourceSample   = { at, cpu, memoryUsed, load: number | null }   // cpu is 0 to 1
DiskUsage        = { path, used, free }                            // bytes
MachineResources = { cpuCount, memoryTotal,
                     samples: ResourceSample[],                    // oldest first
                     disks: DiskUsage[] }                          // fullest first
```

`system.resources` is a `named` route, so the renderer asks each environment on its own and knows which one answered. It asks only connected clouds, every 5 seconds, while the popover is open. A call to a cloud that drops waits in the outbox as any call does, and closing the popover cancels it. An older cloud answers `SchemaError` for the unknown method, which the row reads as "update this cloud".

The desktop decodes a cloud's answer with the `MachineResources` schema, as it does every response. The only paths in it are the disk paths, and the paired desktop can already list those with `fs.list`.

## Out of scope

- Alerts, or a badge on the title bar button. That needs polling while the popover is closed. Add it when a full disk has surprised someone.
- Per-process or per-thread usage. `2026-10-22-resource-monitor.md` covers processes for development, and Codex and Muse share one app server across threads.
- History longer than 10 minutes, or kept across restarts.
- Network and GPU.

## Verification

- `src/main/services/SystemResources.integration.test.ts` drives the sampler with `TestClock` and reads real temp directories. It checks one sample per 5 seconds, the 10-minute cap, one disk for two paths on the same device, and that a missing path is skipped.
- By hand, run `hinacode serve` packed from the branch in a Linux container with `-m 2g`, and pair an isolated desktop with it. Set `HINACODE_SERVE_AUTO_UPDATE=false`, or the daemon replaces itself with the published release. Compare the cloud's row with `memory.current`, `df` and `/proc/loadavg` inside the container. Screenshot the popover in light and dark, then stop the container and check that its row goes offline. A cloud on the published release shows the update message.
