# Contrast hierarchy

Status: Building
Date: 2026-10-14

## Problem

Every piece of text in a thread used to read at the same brightness. A shell command the agent ran, its green check, and the answer the developer was waiting for all competed for the eye. In the sidebar, a thread that was still working looked exactly like one that had finished and was waiting to be read. On a dark screen the near-white text (oklch 0.985 on 0.145, 19:1) also looked harsh. macOS thickens light-on-dark glyphs unless the page opts out, and nothing in the app opted out.

Developers glance at kkcode between other work. The first glance should land on whatever needs them.

## The rule

**Contrast follows attention.** The brighter the text, the more the developer should read it now. Anything an agent is still doing, or did along the way, recedes.

Three tiers, all built from existing tokens:

| Tier     | Token                   | Use it for                                                                                                                                                                  |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read     | `foreground`            | What the developer came for: their own messages, the agent's replies, the open thread, threads that need them, a pull request's title, failing checks.                      |
| Resting  | `sidebar-foreground/80` | Idle rows in a list. They are fine to read but ask for nothing.                                                                                                             |
| Receding | `muted-foreground`      | How the agent got there: tool calls, commands, reasoning, file edits, metadata and section labels. Also anything still in progress: running threads, sub-agents and checks. |

Color carries status on top of the tiers, as `AGENTS.md` describes: amber needs you, red failed, and violet or emerald means working. Success is the expected outcome, so it gets no color. A passing check, a finished tool call or a completed todo shows a muted icon.

### Floors

- Text never goes below 4.5:1 against its surface, in either theme. The light palette's `muted-foreground` is already at 4.64:1 on `accent`, so there is no room for a fourth, fainter tier.
- Dim with a color token, never with `opacity` on a row. Opacity also fades the muted text inside it, which drops to 2.9:1 in dark and 2.3:1 in light at 60% opacity. It also fades the status dot, which is the one part of a working row that should stay visible.
- Expanding something is asking for it. A tool call's trigger brightens to `foreground` on hover, on keyboard focus and while it is open, and the output inside it keeps its normal contrast.

### Dark mode

- Dark `foreground` is oklch 0.92 rather than 0.985. That is 15.6:1 on the background and 14.1:1 on the sidebar, close to what GitHub and Material use for body text on dark surfaces. The background stays at 0.145 so the sidebar and cards keep their separation.
- Dark `muted-foreground` is oklch 0.66 rather than 0.708. A softer `foreground` alone would shrink the step between Read and Receding from 2.48:1 to 2.05:1, so working threads would barely dim. At 0.66 the step is 2.46:1 again, and muted text stays at 4.86:1 on the lightest dark surface (`muted`, `accent`, `sidebar-accent`).
- `body` sets `-webkit-font-smoothing: antialiased`. Without it, macOS renders light text on dark backgrounds with heavier strokes, which reads as glare.

| Pair (dark)                            | Before | After |
| -------------------------------------- | -----: | ----: |
| `foreground` on `background`           |  18.96 | 15.62 |
| `foreground` on `sidebar`              |  17.16 | 14.14 |
| resting row on `sidebar`               |  11.22 |  9.36 |
| `muted-foreground` on `sidebar`        |   6.91 |  5.76 |
| `muted-foreground` on `sidebar-accent` |   5.83 |  4.86 |
| `foreground` to `muted-foreground`     |   2.48 |  2.46 |

## Where it applies

**Transcript.** User messages and replies are Read. Tool calls, command groups, reasoning, sub-agent calls and file edits are Receding, with the tool name in medium weight so the row still scans. The per-call green check is gone. A failed call keeps its red icon. The todo bar above the composer is a trigger like a tool row. Its current step is Receding until hovered, focused or expanded, and the list inside reads at normal contrast.

**Sidebar.** A row's tier comes from its thread's status:

| Status              | Tier     |
| ------------------- | -------- |
| `awaiting_approval` | Read     |
| `limited`           | Read     |
| `idle`, `archived`  | Resting  |
| `running`           | Receding |

The open thread is always Read. The status dot and the Limited badge keep their color in every tier.

**Right-hand panel.** Check runs already list failing first. Failing names are Read and the rest are Receding. Passing and pending checks use muted icons, since neither needs the developer. In Agents, running sub-agents are Receding and finished ones are Read, because their summary is the thing to look at.

## Out of scope

- A "done but not yet seen" marker. Today an idle thread cannot tell whether the developer has read its last turn, so finished threads stay at Resting. That marker needs its own state and comes next.
- Re-sorting the sidebar by attention. Rows that move under the pointer cause misclicks, and the list's manual order is a feature. It needs its own design.
- Named themes keep their own palettes.

## Verification

Seed an isolated instance with threads in every status and a transcript with tool calls, then compare screenshots in light and dark (`verify-kkcode`). Check that contrast stays above 4.5:1 for every tier on every surface it sits on. Hover and expand a tool call to see it brighten.
