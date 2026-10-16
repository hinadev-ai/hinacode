# Agent questions

Status: Shipped
Date: 2026-10-12

## Problem

When an agent asked the user a multiple-choice question, hinacode showed it as a tool approval. Claude's `AskUserQuestion` went through `canUseTool` like any other tool, so the user saw Allow, Allow for session and Deny with the raw JSON. They could not pick an option or type an answer. Codex sent `item/tool/requestUserInput`, which hinacode rejected. In Default mode Codex uses `request_user_input_async` instead, and hinacode dropped those questions from the transcript.

## User flow

1. The agent asks one or more questions. A card titled "Claude Code has 2 questions" appears, and the thread shows as needing the user.
2. For each question the user picks an option (a radio, or checkboxes for multi-select), types an answer in "Or type your own answer", or leaves it blank. A blank question is skipped.
3. Submit sends the answers. Skip (Skip all with several questions) sends none.

## Design

Questions come in two kinds.

- **Blocking**: Claude's `AskUserQuestion`, and Codex's `request_user_input` (Plan mode, or the `default_mode_request_user_input` feature). The provider emits `question_requested`, the runner tracks it like an approval, and the renderer shows `QuestionRequestCard` under the transcript. `questions.respond` carries `QuestionAnswers` (labels or typed text per question id) back to the provider:
  - Claude: `canUseTool` returns `allow` with `updatedInput.answers` keyed by question text, multi-select joined with ", ". When every question is skipped it returns `deny`, so the agent reads "The user skipped these questions".
  - Codex: the request is answered with `{ answers: { [id]: { answers } } }`. Skipped questions are left out.
- **Posted**: Codex's `request_user_input_async` arrives as an `agentMessage` item with `questions` and does not wait. The provider emits `questions_posted`, which appends a `questions` part to the transcript. While that message is the latest in the thread, `PostedQuestionsCard` renders the same card, and Submit sends the answers as a user message through `threads.steer` (which steers the running turn or starts a new one). Once anything follows it, the part renders as its text.

The Claude tool input is decoded with a schema before it reaches the renderer.

## Out of scope

- Option previews (`preview` in `AskUserQuestion`) and per-answer notes.
- A Plan collaboration mode for Codex threads.

## Verification

With `verify-hinacode`: ask a Claude thread to use AskUserQuestion with a single-select and a multi-select question, answer with an option, a checkbox and typed text, and check the tool result in `threads.transcript`; repeat with Skip. Ask a Codex thread to use `request_user_input_async` and answer the posted card; the next user message holds the answers. For blocking Codex questions, enable `features.default_mode_request_user_input` in the thread config.
