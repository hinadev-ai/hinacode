# Usage share card

Status: Building
Date: 2026-11-13

## Problem

Developers post images of which agents and models they use most. HinaCode already records every turn of every agent it runs, but the only way to see that history is to scroll threads. There is nothing to share, and nothing that shows how work splits between Claude Code, Codex, Muse Code, opencode and magpie.

## User flow

1. Settings > Usage shows a card for the last 30 days.
2. The period tabs switch between 7 days, 30 days and All time.
3. Project names are masked as `Project 1`, `Project 2`, ... by rank. The Show project names switch reveals them. It starts off on every visit, so nobody shares a client's repository name by accident.
4. Copy image puts a 2400×1350 PNG on the clipboard. Save PNG downloads `hinacode-usage-<period>.png`.

The card shows:

- turns (prompts sent), threads with a turn in the period, and tokens
- agents ranked by turns, with each agent's share of turns, its turn count and its three most used models
- the top three projects by share of turns
- the HinaCode mark and `hinacode.app`

## Design

### Data

No new tracking. The card reads rows that already exist:

- `message` with `role = 'user'` is one turn. Its `created_at` places it in a period.
- `message.usage` on assistant messages holds the tokens the agent reported for a turn (`inputTokens + outputTokens`).
- `thread.provider`, `thread.model` and `project.name` say who ran it and where.

A thread that switched agents keeps an `agent_switch` part in an assistant message. Each turn goes to the agent that was active when it was sent: the `to` of the latest switch before it, or the `from` of the first switch when it came before any switch. The thread stores only its current model, so turns run by an earlier agent count toward that agent with no model, and a model switch inside one agent counts every turn toward the current model.

`Usage.rows(since)` (`src/main/services/Usage.ts`) runs one query and returns a row per thread and agent: `{ threadId, projectId, projectName, provider, model, turns, tokens }`. The renderer calls it through `usage.rows`, routed to the environment selected in Settings, like `settings.get`.

`summarizeUsage` (`src/shared/usage.ts`) turns rows into the card: it ranks agents and projects by turns, rounds shares with the largest remainder method so they add up to 100%, picks each agent's top models, and replaces project names with `Project <rank>` when masking. It is pure and covered by `usage.test.ts`.

Shares count turns, not tokens. Agents report tokens differently, for example whether cache reads count as input, so a token share would rank agents by how they count, not by how much they were used. The total token count stays on the card as a headline number.

### Card and export

`UsageCard` is a fixed 16:9 layout in the mark's palette (ink, paper, coral), the same in every theme. It is a size container: its spacing and type are `cqw` based (`.share-card` in `index.css`), so the preview fits the settings column and the export keeps the layout at any width.

Export uses `modern-screenshot` (`domToBlob`), which clones the card into an SVG `foreignObject` and draws it on a canvas at `2400 / previewWidth` scale. Save goes through an `<a download>` link, which Electron answers with its save dialog. Copy writes a `ClipboardItem` with `image/png`. Both work in the browser app too.

### Privacy

The query runs in the main process of the machine that owns the data. Nothing is uploaded: the card has no link or share endpoint, and the renderer's CSP (`default-src 'self'`) stops the export from fetching anything outside the app bundle. Masking happens before the names reach the card, so a masked export never contains them.

## Out of scope

- An OG image link. It needs the summary on a server, which conflicts with keeping data on the machine.
- Cost in dollars. Only Claude Code reports cost, so a total would mislead.
- Per-turn model history. Recording the model on each message is a schema change; the card works without it.

## Verification

- `src/shared/usage.test.ts`: period start, rounding to 100%, ranking, top models, counting a switched thread once, masking.
- `src/main/services/Usage.integration.test.ts`: period filtering and per-agent attribution across agent switches against a real SQLite database.
- In the real app with `verify-hinacode`: seed `message` rows, open Settings > Usage, switch periods, toggle names, press Copy image and read the clipboard back (`navigator.clipboard.read()` returns a 2400×1350 `image/png`), press Save PNG and capture the download. `docs/assets/usage-card-sample.png` is such an export from made-up data with names masked.
