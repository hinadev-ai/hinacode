# Add a project with a new GitHub repository

Status: Shipped
Date: 2026-11-01

## Problem

A brand new project has no GitHub repository, so worktrees and pull requests have nothing to push to until the developer leaves HinaCode to run `gh repo create`. After adding any project, the dialog ends on the same screen, so starting work takes one more click.

## User flow

1. In Add project, the developer types a folder and turns on Create GitHub repository. Visibility starts at Private.
2. They click Add project. HinaCode starts the folder's history, publishes it, and adds the project.
3. The dialog closes on that project's New thread draft.

## Design

- `projects.create` takes `createRepository: "private" | "public"`. It runs `git init` when the folder is not inside a work tree, makes an empty `Initial commit` when there is no `HEAD`, then runs `gh repo create --source <root> --remote origin --<visibility> --push`. Existing files stay untracked.
- A folder that already has an `origin` fails with `ProjectOriginTakenError` before anything reaches GitHub, because `gh` creates the repository before it adds the remote.
- `Projects.create` writes the project row only after `gh` succeeds, so a refused name adds no project.
- After a new project is saved, the dialog calls `startThread` with the returned `Project`, since the projects atom may not have refetched yet.

## Out of scope

- Choosing the repository owner or name. `gh` uses the signed-in account and the folder name.

## Verification

- `Projects.integration.test.ts` covers the initial commit, the visibility passed to GitHub, refusing an existing `origin`, and no project when GitHub refuses.
- In the app: add a project with the switch on, land on its draft, and check the private repository and `origin`.
