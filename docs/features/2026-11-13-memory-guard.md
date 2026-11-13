# Memory guard

Status: Shipped
Date: 2026-11-13

## Problem

A developer runs many threads on one machine, and every agent starts tools that hold memory: test runners, type checkers, dev servers. When the machine runs short, Linux does not stop the one tool that caused it. It stops everything.

On 2026-11-10 a cloud ran 24 magpie threads. `systemd-oomd` saw memory pressure on `app.slice` above 50% for 20 seconds and killed `hinacode-cloud.service` whole: the daemon, every agent and every tool. Half the swap was still free. All 24 turns were lost, and after the restart no transcript said why.

The kernel's OOM killer ends the same way. It kills one process, and a systemd unit with the default `OOMPolicy=stop` then stops the rest of the unit.

## User flow

1. There is nothing to turn on. The developer runs threads as usual.
2. When the machine is about to run out of memory, HinaCode stops one thread, the one whose processes hold the most. Its turn fails with the reason:

   > Stopped to free memory. This machine was about to run out, and this thread's processes held the most: 3.6 GB. The largest was `node node_modules/.bin/vitest run` at 2.0 GB.

3. Every other thread keeps working. If memory is still short, the next heaviest thread stops, one at a time, until the machine recovers.
4. A stopped thread keeps its session and its worktree. The next message resumes it.

## Design

`src/main/memoryGuard.ts` is one fiber in the layer graph, so the desktop app and `hinacode serve` both run it. It works on Linux only. Every second it takes a reading, judges it, and stops at most one thread.

### The reading

```ts
MemoryReading = { stalledPercent, freeBytes, capacityBytes }
```

- `stalledPercent` is the highest `full avg10` among `/proc/pressure/memory` and the `memory.pressure` of every cgroup from the root down to our own. It is the share of the last 10 seconds in which every task that wanted to run waited on memory.
- `freeBytes` of `capacityBytes` is the room under the tightest limit we live in. For the host that is `MemAvailable + SwapFree` of `MemTotal + SwapTotal`. For an ancestor cgroup with a finite `memory.max` it is `max - current` plus its file cache, plus the swap it may still use.

It takes both because the machine dies in two ways, and neither shows in the other's number. Under a hard limit, or once swap is full, pressure stays near zero until the kill, and only free memory warns. With swap to spare, free memory looks fine while the machine thrashes, and `systemd-oomd` kills on pressure.

### The decision

| Reading                                                    | `judge` says                                      |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `freeBytes` under the reserve, `min(1 GiB, capacity / 10)` | Stop a thread now, one each second while it lasts |
| `stalledPercent` at 40 or more for 10 seconds              | Stop a thread, then count 10 seconds again        |

`systemd-oomd` kills at 50% for 20 seconds on Ubuntu 24.04 and on omarchy, the two machines we looked at, so the stall rule acts first.

### The thread to stop

The guard stops only threads with a running turn. A thread's memory is the resident and swapped memory of its agent processes and of every process under them, from `/proc/<pid>/status`. Sub-agents started with `run_agent` count toward their thread. Terminals do not, because the developer started those. `services/Ports.ts` keeps agent pids apart from terminal pids for this.

The guard stops the heaviest thread. When every running agent together holds less than the reserve, stopping one would not help, and the guard rests for 30 seconds.

### The stop

1. `SIGKILL` every process under the thread's agents. That frees the memory at once.
2. `AgentRunner.abort(threadId, message)` ends the turn as `turn_failed` with the message and closes the provider session.

The thread keeps its `providerSessionId`, so the next message resumes it. The transcript shows the message the way it shows any failed turn. There is no new status, table or rpc method.

`HINACODE_MEMORY_GUARD=0` turns the guard off.

## Out of scope

- macOS and Windows. Neither has pressure files, and our one incident is from Linux.
- Codex and Muse threads. Each shares one app server across threads, so a process tree does not belong to one thread. The guard never measures or stops them.
- Threads with no running turn. A dev server that an idle thread left behind keeps its memory. The ports panel stops those.
- Telling the agent why its tools died, and a Resume button. Issue #809 tracks an interrupted status with Resume, and a stopped thread should use it once it exists.
- A cgroup scope per agent with `MemoryMax`, which is how T3 Code does it. It needs systemd, and a limit per agent chosen before anyone knows what the machine can spare. The kernel still picks what dies. It also cannot see pressure while swap is free, which is what killed our cloud.
- Pausing a thread with `SIGSTOP` or `cgroup.freeze`. A paused process keeps its memory.
- A cap on concurrent turns. How many turns fit depends on what their tools do, and a fixed number cannot know that.
- Settings for the two thresholds.

## Verification

- `src/main/memoryGuard.test.ts` covers `judge`, the per-thread sum, the choice of thread and the message.
- `src/main/memoryGuard.integration.test.ts` reads fixture `/proc` and cgroup trees for a host, a cgroup limit with no swap, and a container that shares the host's swap. On Linux it then runs the guard over real child processes: the heaviest thread's tools die with `SIGKILL`, its turn is aborted with the reason, and the lighter thread is left alone.
- `src/main/services/AgentRunner.integration.test.ts` checks that `abort` fails the turn with the message, closes the agent process, and leaves a thread that resumes.
- By hand, on a machine you can break, never your own. Ours was an 8 GB Ubuntu 24.04 VM with `systemd-oomd`. `hinacode serve` ran from the branch as a systemd user unit, with a fake `claude` whose turn starts a tool that allocates about 1.5 GB and keeps writing to it.

  | Machine                                            | Guard off (`HINACODE_MEMORY_GUARD=0`)                                                                          | Guard on                                                                                                        |
  | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
  | 6 GB zram plus 10 GB disk swap, 11 threads         | `systemd-oomd` killed the unit at 90 s. After a restart all 11 threads read `idle`, and no transcript says why | 6 threads stopped between 34 s and 85 s on the stall rule. 5 kept running, and the unit was alive at 180 s      |
  | 7.25 GiB limit on `user.slice`, no swap, 8 threads | The kernel killed a tool at 17 s, and systemd stopped the unit with `Failed with result 'oom-kill'`            | 4 threads stopped between 13 s and 20 s on the free memory rule. 4 kept running, and the unit was alive at 90 s |

  In both guarded runs a stopped thread showed the message and answered its next message. The desktop app, under the same limit with 6 threads, stopped 2 and stayed up.

  The numbers come from one VM and a synthetic tool that writes to all of its memory in a loop, the worst case for swap. The two thresholds have not been tuned on real agent workloads.
