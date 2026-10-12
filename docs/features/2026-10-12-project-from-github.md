# Add a project from GitHub

Status: Shipped
Date: 2026-10-12

## Problem

Adding a project needed a folder that already existed. To work on a repository you hadn't cloned, you left kkcode, cloned it in a terminal, and came back to browse to it.

## User flow

1. Open Add project and type or paste the repository in the same field as a folder: `owner/repo`, any github.com link (https, ssh, a link into the repository), or a whole `git clone` or `gh repo clone` command.
2. The dialog switches to cloning. "Clone to" defaults to `<parent of your newest project>/<repo>`, or `~/code/<repo>` with no projects yet. Browse picks the parent folder. The name defaults to the repository name.
3. `Clone and add` clones the repository and adds it as a project. A path keeps the dialog working as before.

## Design

- `shared/github.ts` parses the input in the renderer, so the dialog switches as you type. No hint is needed for the accepted forms.
- `projects.clone` validates `owner` and `name` with a schema before they reach a command line. `Projects.clone` expands `~`, requires an absolute path, creates the parent folder, and runs `GitHub.clone`.
- `GitHub.clone` uses `gh repo clone`, so private repositories and the user's preferred protocol work. Without a signed-in `gh`, it falls back to `git clone` over https with prompts turned off.
- A target that already holds a clone of the same repository is added without cloning, so retrying after a failed add works.

## Out of scope

- Hosts other than github.com.
- Clone progress and cancelling a clone in flight. The button reads `Cloning…` until it finishes.

## Verification

- `shared/github.test.ts` covers the accepted forms and what stays a path.
- `ipc.integration.test.ts` covers adding an existing clone without network and refusing bad input.
- In the app: pasting a GitHub URL and cloning `octocat/Hello-World` added the project with the right origin.
