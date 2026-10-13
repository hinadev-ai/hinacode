# specs

TLA+ models of the protocols in kkcode where several actors share state: the main process, the renderer, the agent CLIs, and git. TLC, the TLA+ model checker, runs every interleaving of their steps within small bounds. A test runs one.

| Spec                    | Models                                                                   | Known bugs it pins                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaudeTurnRouting.tla` | `agents/claude/index.ts` pump, steer, interrupt, with AgentRunner's turn | A steer sent while Claude finishes is answered but never shown (`NoSilentDrop`), and that answer can land in the next turn (`NoCrossTurnLeak`)                    |
| `TranscriptSync.tla`    | `stores/messages.ts` snapshot plus `seq` replay over Electron IPC        | Opening a streaming thread can fold a push twice (`NoDuplicateApply`). Leaving and reopening within one round trip can lose events (`NoGapAtQuiescence`)          |
| `WorktreeLifecycle.tla` | `Worktrees.ts` create, remove and archive racing with turns              | A failed deletion restores a row whose checkout is gone (`LiveRowHasDirectory`). A turn sent to a live worktree can run in the project root (`TurnRunsWhereSent`) |

## Run

```sh
pnpm check:specs                       # every config
pnpm check:specs TranscriptSync.cfg    # one config
```

It needs Java 11 or newer (`mise use java@temurin-21`), and downloads a pinned `tla2tools.jar` into `node_modules/.cache`.

`Name.cfg` checks properties that must hold. `Name.Property.cfg` starts with `\* expect: <TLC output>` and pins a known violation, so it passes while TLC still finds the bug. When you fix the bug, change the spec to model the new code and delete that config.

To read a counterexample, run TLC on the config directly. It prints the shortest sequence of states that breaks the property:

```sh
java -cp node_modules/.cache/tla2tools-1.7.4.jar tlc2.TLC -config specs/TranscriptSync.NoDuplicateApply.cfg specs/TranscriptSync.tla
```

## Writing a model

- One action is the code between two real awaits: a subprocess, IPC, a timer, or a Semaphore wait. `node:sqlite` is synchronous, so a run of SQL calls is one action. Splitting finer finds interleavings that cannot happen.
- Put a `\* file:line` comment above each action.
- Model black boxes (the Claude CLI, Electron IPC, git) nondeterministically, and make each assumption about them a `CONSTANT`. Check it against the real thing with a script in `probes/`, and rerun the probe after upgrading it.
- Keep the bounds small, such as 2 turns and 2 steers. A pass only covers those bounds, but most interleaving bugs need only two or three actors.
- When you change a modeled protocol, update its spec in the same PR.
