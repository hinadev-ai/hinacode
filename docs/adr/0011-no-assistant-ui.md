# 0011. Don't adopt assistant-ui; port its good patterns

Status: Accepted
Date: 2026-10-11

## Context

assistant-ui offers chat primitives and a runtime.

## Decision

Don't adopt it.

- It would add a layer: the zustand store would go through a `convertMessage` adapter into `useExternalStoreRuntime`.
- It would drop LegendList virtualization.
- It assumes the frontend owns the history, for edit, branch and regenerate. Here the agent sessions own it.
- It is about 2.8 MB and brings Radix alongside Base UI.
- Approvals don't map onto it.

Port the patterns instead:

- collapse consecutive tool calls into "N steps"
- open reasoning while it streams and close it after
- a shimmer on running labels
- animated disclosures
- copy a finished message
- a scroll-to-latest button

## Consequences

We own the chat components. Revisit `react-lexical` for a richer composer, or `streamdown` for streaming Markdown (#12).
