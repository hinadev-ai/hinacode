interface DocumentTemplate {
  readonly id: string
  readonly name: string
  readonly useFor: string
  readonly markdown: string
}

const fence = "```"

export const DOCUMENT_TEMPLATES: ReadonlyArray<DocumentTemplate> = [
  {
    id: "investigation",
    name: "Investigation report",
    useFor: 'An audit, a bug hunt, "why is X slow", or "find every place that does Y".',
    markdown: `# <What was investigated>

> [!NOTE]
> <The answer, how sure you are, and what to fix first.>

## Findings

| # | Finding | Impact | Evidence |
| --- | --- | --- | --- |
| 1 | <One-line claim> | <High, medium or low> | <Verified, inferred or not measured> |

### 1. <The finding, stated as a claim>

<What happens, where it happens (\`path/to/file.ts:42\`), and how you know.>

**Fix.** <The smallest change that removes it.>

## Ruled out

- <What you checked that is not the cause, and how you checked it.>

## How I checked

<Setup, commands and data, and the limits of the method.>

## Open questions

- <What you could not settle, and what would settle it.>`,
  },
  {
    id: "design",
    name: "Design doc",
    useFor: "A feature or a change, written before it is built.",
    markdown: `# <Feature name>

Status: Draft
Date: <YYYY-MM-DD>

> [!NOTE]
> <Who this is for, what changes for them, and the decision that shapes the rest.>

## Problem

<Who hits it, in what situation, and what it costs them today.>

## User flow

1. <What the developer does and sees, step by step, including the keyboard path.>

## Design

### Data shape

${fence}ts
<The types and the persisted format, before any logic.>
${fence}

### <Moving part>

<How it works, what you decided and why. One subsection per moving part.>

${fence}mermaid
<A flow or lifecycle, only when a picture is clearer than the paragraph.>
${fence}

## Out of scope

- <What this deliberately does not do, and why.>

## Verification

- [ ] <How to prove it works in the real app.>
- [ ] <The tests that cover it.>`,
  },
  {
    id: "research",
    name: "Research map",
    useFor: "A survey of ideas, issues, a codebase or a field that ends in what to take.",
    markdown: `# <Topic>

> [!NOTE]
> <What is worth taking, in two or three sentences.>

## Verdict

| Idea | Who notices | Size | Take |
| --- | --- | --- | --- |
| <Name> | <The person it changes things for> | <S, M or L> | <Take, maybe or skip> |

## <Idea>

<What it is and where you found it.>

**Change.** <What we would build.>

**Evidence.** <Links or \`path:line\`, each marked verified or inferred.>

## Already done well

- <What we already have, so nobody rebuilds it.>

## Checked and skipped

- <The idea, and the reason in one sentence.>

## Suggested order

1. <First, because ...>`,
  },
  {
    id: "comparison",
    name: "Comparison",
    useFor: "Two or more options side by side, such as ours and theirs or two libraries, ending in a decision.",
    markdown: `# <Option A> and <Option B> for <purpose>

> [!IMPORTANT]
> <The recommendation and the one reason that decides it.>

## At a glance

| | <Option A> | <Option B> |
| --- | --- | --- |
| <A criterion that matters here> | <Short fact> | <Short fact> |

## How <Option A> works

<The mechanism, with sources.>

## How <Option B> works

<The mechanism, with sources.>

## What to take

- <A concrete change, and why it is worth its cost.>

## What you need to know

- <Gaps, ordering and risks that remain after the decision.>`,
  },
  {
    id: "experiment",
    name: "Experiment",
    useFor: "Measuring candidates, or a change before and after.",
    markdown: `# <What was measured>

> [!NOTE]
> <The result in numbers, and what it means for the decision.>

## Question

<The decision this measurement settles.>

## Setup

- **Machine and data.** <Where it ran, on what input.>
- **Method.** <Commands, runs per case, and the statistic you report.>

## Results

| Case | Median | p95 | Change |
| --- | --- | --- | --- |
| Before | <...> | <...> | |
| <Candidate> | <...> | <...> | <-32%> |

## Recommendation

<What to adopt, and the tradeoff you accept.>

## Limits

- <What this measurement does not show.>`,
  },
  {
    id: "review",
    name: "Review ledger",
    useFor: "Reviewing pull requests, a branch or a batch of changes, and tracking each item to done.",
    markdown: `# <What is under review>

Base: \`<branch or commit>\`

> [!NOTE]
> <How many items, how many are ready, and what blocks the rest.>

## Status

| Item | State | Head | Next step |
| --- | --- | --- | --- |
| <#123 Title> | <Ready, changes needed or blocked> | \`<sha>\` | <...> |

## Findings

| Severity | Where | Finding | Fix | State |
| --- | --- | --- | --- | --- |
| <High> | \`<path:line>\` | <What is wrong> | <What to change> | <Open or fixed> |

## Verification

- [ ] <Item>: <what you ran or saw, for which head commit>

## Skipped

- <The item, and why.>`,
  },
  {
    id: "plan",
    name: "Plan",
    useFor: "Splitting work into steps or threads, a roadmap, or a migration.",
    markdown: `# <Goal>

> [!NOTE]
> <What will be true when this is done, and the first step.>

## Steps

| # | Step | Check | Owner |
| --- | --- | --- | --- |
| 1 | <A small unit of work> | <How we know it is done> | <Thread, person or agent> |

## Choices I made

- <The decision and why, so the developer can overturn it.>

## Left for you to decide

- [ ] <A question only the developer can answer.>

## Risks

- <What could go wrong, and the fallback.>`,
  },
]
