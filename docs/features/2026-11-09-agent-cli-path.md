# Agent CLI path

Status: Building
Date: 2026-11-09

## Problem

Settings > Providers shows every agent switched on, whether or not its CLI is on that machine. A cloud with only Claude Code installed lists Codex and Muse Code as enabled, while the composer's picker offers only Claude Code, so the two disagree. A CLI installed outside `PATH`, such as `~/.local/share/codex/bin/codex` or a version manager's shim, cannot be used at all.

## User flow

1. Settings > Providers, on any environment. An agent whose CLI is missing on that machine shows **Not installed** under its name, and its switch is off and disabled.
2. Selecting it shows "Codex was not found on this machine.", an **Install Codex** link and a **CLI path** field.
3. Typing a path and pressing Save stores it for that machine. If something runs there, the agent turns on with the switch it had before. If not, the field says "Nothing runs at <path>."
4. For an installed agent, the CLI path field sits above Accounts. Its placeholder is the path in use, so leaving it empty keeps the `PATH` lookup.

The picker, the automation form and new-thread defaults leave out agents that are not installed.

## Design

- `Settings.providerBinary`, one optional path per agent, in the machine's `settings.json`. `~/` expands to the home directory. Extra Claude Code and Codex accounts keep their own `binary`.
- `installedBinary` in `src/main/agents/binary.ts` uses the configured path when it is asked for the agent's default command name. It reads the paths through the `AgentBinaries` context reference, which `app.ts` fills from Settings, so the eight call sites keep their signatures. magpie launches the `claude` binary, so it uses the path set for Claude Code and has no path field of its own.
- `agents.binaries` answers `{ installed, path }` for every agent, routed to the environment the renderer names. A simulated agent (`HINACODE_MOCK_CLAUDE`, `HINACODE_MOCK_AGENTS`) counts as installed with no path.
- `enabledProviders(settings, installed)` and `startingProvider(settings, installed)` treat a missing agent as off. The stored switch is untouched, so installing the CLI later brings the agent back. Until a machine answers, or when an older cloud does not know the method, every switched-on agent counts as installed.

## Out of scope

- Subagent choices. A turn would pay for the lookups, and a missing agent already lists no models; `run_agent` on one fails with the "not installed" message.
- Noticing a CLI removed while the app runs. A found path stays cached until restart, as before.

## Verification

- `src/main/agents/binary.test.ts`: a configured path wins over `PATH`, magpie uses the `claude` path, a missing path names itself in the error, and a simulated agent counts as installed.
- `src/shared/domain.test.ts`: a missing agent is not enabled, unknown means installed, and new threads start on the first installed agent.
- `ModelSettings.component.test.tsx`: a missing Codex shows a disabled, unchecked switch, and saving a path that runs turns it on.
- By hand: a `hinacode serve` cloud in Docker with no agent CLIs installed. Settings > Providers for it shows Codex, Muse Code and opencode as Not installed, and the picker shows only the mocked Claude Code.
