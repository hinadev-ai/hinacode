# Project groups

Status: Building
Date: 2026-11-11

## Problem

A developer who works on several related repositories, such as a web app, its API and a shared library, repeats the same setup in each one. They write the same rules into every `AGENTS.md`, copy the same skills into every `.agents/skills`, and start a thread per repository by hand when one change spans them. Sidebar groups fold those projects together, but the group carries nothing to the agents. No thread can see across the group either, because the thread tools reach only the caller's own project.

## User flow

1. The developer groups projects as today: a project's "…" menu, then Move to group.
2. The group header gets a Conductor entry. Opening it starts a thread in the group's own folder, `<dataDir>/groups/<groupId>`, which holds `AGENTS.md` and `skills/`. The file explorer shows both, so the developer edits them there, or asks the conductor to.
3. Every thread on this desktop in a grouped project gets the group's `AGENTS.md` and skills in its instructions, on every provider, on top of the repository's own.
4. The developer tells the conductor what to do across the group, such as "rename `userId` to `accountId` in the API and the web app". The conductor reads the member projects, starts a thread in each with `create_thread`, follows them with `read_thread`, steers them with `send_to_thread`, and reports back.
5. Delete group asks first when the group has conductor threads, because those threads go with it. The folder stays on disk.

## Design

**Data.** `ClientSettings.sidebarGroups` stays the source of truth for a group's name, order, collapsed state and members. Each group also has a project row of the new kind `group` (migration `0049_project_group_kind`), whose id is the group's id and whose root is `<dataDir>/groups/<groupId>`. The group project's threads are the conductor. Reusing a project gives the conductor a workspace, a thread list, the file explorer and the thread tools without new tables.

**Reconcile.** `Projects.ensureGroups(groups)` upserts one `group` project per group and creates its folder, `AGENTS.md` and `skills/` when missing. It never overwrites a file. Startup and `clientSettings.set` call it, so groups made before this change get their project on first launch. It never deletes: Delete group calls `projects.remove` on the group project after the renderer confirms.

**Membership in main.** A project's group is `groupOf[project.repository] ?? groupOf[project.id]`, the same row key the sidebar uses. A `group` project belongs to itself.

**Instructions.** `agentInstructions` gains a `<group>` block for any thread whose project has a group. It carries the group's `AGENTS.md` and one line per skill with its name, description and the absolute path of its `SKILL.md`, read from the frontmatter of `skills/*/SKILL.md`. All four providers already take the instructions string, so one block reaches every provider. A conductor thread's block also lists each member project with its id, name, root path and repository.

**Thread tools.** For a conductor thread, the thread tools reach every project of its group instead of only its own. `create_thread` takes an optional `project`, the id of a member project, and refuses any other. `list_threads` lists the threads of every member project. Threads a conductor creates keep `parent_id`, but nest only within their own project's list, as today.

**Sidebar.** A `group` project never renders as a project row. Its threads render under the group header, below a Conductor row that starts a new conductor thread. Pickers that list projects skip the `group` kind, as they skip Chats.

## Out of scope

- Cloud machines. Group instructions and skills reach threads that run on this desktop only. A cloud thread in a grouped repository behaves as today.
- Turning installed skills off per group. The group adds skills; it does not filter the developer's own.
- Native skill loading. Claude's SDK can load a plugin folder, but the instructions block works on every provider. Revisit if agents skip skills they should use.
- A conductor that acts without being asked. Routines can start one later.

## Verification

- `Projects.integration.test.ts`: `ensureGroups` creates one project and folder per group, keeps existing files, and is idempotent.
- `instructions.test.ts`: the `<group>` block for a member thread and for a conductor thread, and no block outside a group.
- `mcp/server.integration.test.ts`: a conductor creates a thread in a member project, and is refused for a project outside the group. A member thread still reaches only its own project.
- `verify-hinacode`: group two projects, write a rule into the group's `AGENTS.md`, start a Sonnet thread in one project and ask for its group rules. Start a conductor and ask it to start a thread in each project. Screenshot the sidebar.
