# First-run checklist

Status: Building
Date: 2026-11-17

## Problem

A new user opens HinaCode to a heading, one line of text and two buttons. Nothing says whether any agent on the machine is signed in, and the only place that does is the Machine setup table in Settings. Someone with a signed-out Claude Code finds out when their first turn fails.

## User flow

1. The user opens HinaCode with no threads yet. The home screen shows a "Get started" checklist with three steps.
2. **Sign in to an agent.** One row per enabled, installed agent with its state: signed in (with the plan when there is one), not signed in (with the agent's own login command), or unavailable. Signing in happens in the user's terminal. When they switch back to HinaCode, the signed-out rows are checked again, and the step ticks itself once one agent is ready. "Check again" does the same on demand, and "Agent settings" opens Settings > Providers.
3. **Add a project.** "Add project" opens the usual dialog. The step is done once a folder project exists. The built-in Chats project does not count.
4. **Start your first thread.** "New thread" opens the palette's new-thread list.

The first step that is not done gets the primary button. Steps can be done in any order. Once any thread exists, the checklist is gone and the home screen shows its usual buttons.

## Design

Everything the checklist shows is derived from state the renderer already has, so there is nothing to persist and no "onboarding finished" flag:

- agents: `enabledProviders(settings, installed)` and `accountAtom(null, provider, null)` for each
- project: `projectsAtom`, any project of kind `folder`
- first run: `useThreads` has no thread (threads load before the first render, so existing users never see it flash)

Rechecking calls `refreshAccountAtom`, which asks the agent again and refreshes `accountAtom`, so the composer and Settings pick up the new sign-in too. The window-return recheck only runs for signed-out agents while the checklist is on screen.

The checklist lives in `src/renderer/routes/home.tsx`. It adds no rpc method.

## Out of scope

- Running the login command in a HinaCode terminal. Terminals belong to a thread (`Terminals.open` resolves the cwd from the thread's workspace), and the home screen has none. Worth doing once there is a terminal that is not tied to a thread.
- Relay sign-in for phone control. That belongs after the first turn, not before it.
- Asking for a GitHub star.
- The web client served by `hinacode serve`, which has no "this machine". It keeps the old home screen.

## Verification

- `src/renderer/routes/home.component.test.tsx` covers the step states, the primary button moving, Check again, and the checklist disappearing once a thread exists.
- In the real app, with `verify-hinacode`: a fresh profile shows the checklist. Adding a project ticks step 2, and sending the first message replaces the checklist with the usual home screen.
