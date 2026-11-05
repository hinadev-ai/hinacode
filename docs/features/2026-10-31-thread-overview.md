# Thread overview and project actions

Status: Building
Date: 2026-10-31

## Problem

While a thread runs, the developer wants three answers at a glance: where it runs, how its workspace was set up, and how to start the project's usual commands (dev server, tests). Today the first two live in the Details tab of the side panel, which competes with Files, Changes and the browser for the same space. The third does not exist: the developer opens a terminal and types `pnpm dev` again in every worktree.

## User flow

1. A thread shows one floating card at the top right of the transcript, toggled by the list icon in the thread header. The choice persists.
2. Environment shows the project, the machine (this machine or a cloud) and the worktree branch. A worktree thread also shows Changes, with the worktree's added and removed lines, which opens the Changes tab.
3. Pull requests lists the branch's pull request first, then the linked ones, newest first. A colored dot on the icon shows checks. A row opens that pull request in the Pull requests tab.
4. Every pull request row has a "Pull request actions" menu: view it (with copy link and open on GitHub), Code changes with its line counts (opens the Changes tab), Status, Add to chat (appends the URL to the composer), and Unlink from thread for linked ones.
5. Setup script shows the first lines of the project's setup script. Run executes it in a new terminal tab, Edit opens the project dialog, and Log opens the Details tab with the setup log.
6. Actions lists the project's named commands, then the global ones, marked with a globe, that every project on this machine shares. Clicking one opens a terminal tab named after it, in the thread's workspace, and types the command. The shell stays open when the command ends. The + in the section header and the pencil on a row open a dialog with Name, Command and where it is available (this project or all projects), plus Delete when editing. Changing where an existing action is available moves it.
7. Agents appears once the thread has started any. It lists the five newest, with status, tool count, tokens and elapsed time. A row opens that sub-agent's transcript, a running one has a stop button on hover, and View all opens the Agents tab.
8. Chat threads have no project actions, so they show Environment, global Actions, Pull requests and Agents.

## Design

- `Project.actions: Array<{ name, command }>`, stored as JSON in `project.actions` (migration 0032) and written through `projects.update`. Global actions are `Settings.actions`, written through `settings.set`. Settings belong to a machine, so a global action runs wherever that machine's terminals run.
- `terminal.open` takes an optional `command: { title, line }`. `Terminals` writes the line into the new shell and keeps the title on the `TerminalSession`, so the drawer tab shows it after a reload. Every terminal now gets `HINACODE_ROOT_PATH` and `HINACODE_WORKTREE_PATH`, so the setup script runs the same way it does during worktree setup.
- `ThreadOverview` renders inside the thread view's floating column, above the floating tiny VM. When the transcript column (48rem) would run under the card, the transcript and composer get end padding so they move left instead.

## Out of scope

- Actions stored in the repository, shared with a team. The setup script lives in the database, and actions follow it.
- Status of a running action. The terminal tab is the status.

## Verification

- `Terminals.integration.test.ts` runs a command with the setup variables and keeps the shell running. `Projects.integration.test.ts` keeps actions across edits that leave them out.
- With `verify-hinacode`: open a worktree thread, run an action, and read its output with `terminal.attach`; add, edit and delete an action through the dialog and read `projects.list`.
