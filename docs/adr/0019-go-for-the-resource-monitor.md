# 0019. Go for the resource monitor

Status: Accepted
Date: 2026-10-22

## Context

The [resource monitor](../features/2026-10-22-resource-monitor.md) reads per-process memory, CPU and environment for every process on the machine, every few seconds. Node can read Linux `/proc` cheaply, but on macOS it cannot call `proc_pid_rusage` for `phys_footprint` or read another process's environment without a native addon, and an addon has to be rebuilt for every Electron ABI. Doing that scanning inside the main process would also put it on the event loop of a process it is measuring.

## Decision

The monitor is a separate Go binary in `tools/resource-monitor`, built with `CGO_ENABLED=0`. It uses gopsutil for process listing and calls libproc through purego on macOS.

## Consequences

- A second toolchain. Contributors without Go still run `pnpm dev`; the build step skips the monitor and says so. CI installs Go to run its tests.
- One Linux machine cross-compiles every OS, since neither gopsutil nor purego needs cgo. CI still runs the tests on the macOS runner, because the `phys_footprint` path only runs there.
- The binary is a development tool. Shipping it to users would add signing, notarization and per-platform artifacts. Revisit this decision when users need it.
