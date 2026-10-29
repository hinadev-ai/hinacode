# specs

TLA+ models of the protocols in hinacode where several actors share state: the main process, the renderer, the agent CLIs, and git. TLC, the TLA+ model checker, runs every interleaving of their steps within small bounds. A test runs one.

| Spec                    | Models                                                                                                                                      | Checks                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaudeTurnRouting.tla` | `agents/claude/index.ts` pump, steer, interrupt, with AgentRunner's turn                                                                    | Every answer reaches the turn that sent its prompt and no reply to a background sub-agent is lost (`NoCrossTurnLeak`, `NoSilentDrop`), and every turn ends (`TurnsEnd`)                                                                                                                                                                                                           |
| `TranscriptSync.tla`    | `stores/messages.ts` snapshot plus `seq` replay over Electron IPC                                                                           | Each event is folded once (`NoDuplicateApply`, `NoGapAtQuiescence`) and a superseded snapshot is never applied (`StaleSnapshotNeverApplied`)                                                                                                                                                                                                                                      |
| `WorktreeLifecycle.tla` | `Worktrees.ts` create, remove and archive racing with turns and setup                                                                       | A live row has its checkout (`LiveRowHasDirectory`), a turn sent to a worktree runs there (`TurnRunsWhereSent`), and archiving works even when setup hangs (`ArchiveEventually`)                                                                                                                                                                                                  |
| `RelayRouting.tla`      | One client's link to a relay machine: `Environments.ts` maintain and the phone's `transport.ts`, with token rotation and relay sync         | The token reaches the machine only (`TokenStaysWithMachine`), the client gives up only on a stale token (`GivesUpOnlyOnStaleToken`), and the link settles connected, on the direct address at home (`Recovers`, `LocalAtHome`)                                                                                                                                                    |
| `SealedHandshake.tla`   | One remote socket under `shared/handshake.ts` and `remote/server.ts`, with an attacker on the path that replays, rewrites and forges frames | A connected client shares its channel with the machine (`ConnectedToMachine`), no frame is readable even after the token leaks (`FramesStaySealed`), the machine runs each call once (`MachineRunsOnlyClientCalls`), and an older machine gets no call (`NothingToOlderMachine`). `Downgrade.cfg` pins that a forged plain `ready` can make the client report an outdated machine |

## Run

```sh
pnpm check:specs                       # every config
pnpm check:specs TranscriptSync.cfg    # one config
```

It needs Java 11 or newer (`mise use java@temurin-21`), and downloads a pinned `tla2tools.jar` into `node_modules/.cache`.

`Name.cfg` checks properties that must hold, and so does a config such as `Name.Background.cfg` that checks them under other bounds. `Name.Property.cfg` starts with `\* expect: <TLC output>` and pins a known violation, so it passes while TLC still finds the bug. When you fix the bug, change the spec to model the new code and delete that config.

To read a counterexample, run TLC on a config directly. It prints the shortest sequence of states that breaks the property:

```sh
java -cp node_modules/.cache/tla2tools-1.7.4.jar tlc2.TLC -config specs/Name.Property.cfg specs/Name.tla
```

`pnpm chart:thread` redraws the thread and worktree chart in `docs/arch.md` from the states TLC reaches in `WorktreeLifecycle.Liveness.cfg`. Run it after changing that spec.

## Writing a model

- One action is the code between two real awaits: a subprocess, IPC, a timer, or a Semaphore wait. `node:sqlite` is synchronous, so a run of SQL calls is one action. Splitting finer finds interleavings that cannot happen.
- Put a `\* file:line` comment above each action.
- Model black boxes (the Claude CLI, Electron IPC, git) nondeterministically, and make each assumption about them a `CONSTANT`. Check it against the real thing with a script in `probes/`, and rerun the probe after upgrading it.
- Keep the bounds small, such as 2 turns and 2 steers. A pass only covers those bounds, but most interleaving bugs need only two or three actors.
- When you change a modeled protocol, update its spec in the same PR.
