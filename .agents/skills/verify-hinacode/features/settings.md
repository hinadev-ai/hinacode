# Settings

The settings page has twelve pages in two groups. `App`: `General` (language, version and update, the `Worktrees` list), `Appearance`, `Keybindings` (record, reset, conflict warning), `Notifications`, `Environments` (see `remote.md`). `This machine`, or a picked cloud: `Models` (default model, default access and accounts per agent, thread naming, pull request guide), `Archive`, `Workspace`, `Integrations` (GitHub sign-in state, Linear API key, Slack user token, stored encrypted and never shown again), `Automations` (see `automations.md`), `Remote` (see `remote.md`), `Experimental`. Selects and switches apply at once; text fields apply on `Save` or `Enter`. Everything survives a relaunch. No agent turn is needed.

## Automated coverage

`e2e/features/settings.feature`: switching to 繁體中文 and starting in it, the Claude default model preselecting in the new thread composer, `Ctrl+B` hiding and showing the sidebar, recording a shortcut and using it, Escape cancelling a recording, the conflict warning and reset, a saved shortcut replacing the default after a restart, the Linear API key being stored, reported as stored, and cleared, and `Archive settings are saved`. `e2e/features/navigation.feature`: `Escape leaves settings for the thread you came from` and `Escape that closes the sidebar overlay stays in settings`. `e2e/features/agent-accounts.feature`: `The models tab shows who Claude Code is signed in as`.

## Sub-features

- `language` (e2e) switches between `English`, `繁體中文` and `日本語`; the whole UI re-renders and the choice persists.
- `default-model` (e2e for Claude) sets the default model per agent; the new thread composer then preselects it.
- `keybinding-record`, `keybinding-conflict`, `keybinding-reset`, `keybinding-effect` (e2e).
- `secret-linear` (e2e) stores, replaces and clears the Linear API key; the UI only ever says `A key is stored.` or `No key stored.`
- `archive` (e2e) the two Archive switches persist.
- `leave` (e2e) `Escape` returns to the thread you came from.
- `account-claude` (e2e) Models shows the Claude Code sign-in.
- `default-model-codex` the same picker for Codex, fed by the live `codex` model list.
- `secret-slack` the same write-only field for the Slack user token (`slack.token`).
- `gh-status` the GitHub row reads the `gh` sign-in state; see `mcp-and-pull-requests.md`.

## How to get to it (user POV)

- Title bar link `Settings`, or `Ctrl+,`. `Escape` returns; there is no back button.
- Page buttons in the `Settings sections` nav, under `App` and `This machine`.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes, project `demo` exists, `codex` is installed for the Codex model list.
- `AB="agent-browser --session kkv-$PORT-settings"`, connected.

- **Codex default model.** Open `Models`. `$AB click '#default-model-codex'`, `$AB wait '[role=option]'`, pick the first option. `$S/rpc.ts $PORT settings.get` shows it under `defaultModel.codex`, and an automation switched to Codex preselects it. Screenshot `settings-01-codex-default.png`. If `codex` cannot list models the field is a free-text id with a notice; report that instead.
- **Slack token.** Open `Integrations`, `$AB fill '#secret-slack-token' xoxp-test-not-real`, `$AB press Enter`. The status reads `A key is stored.`, `$S/rpc.ts $PORT secrets.has '{"name":"slack.token"}'` prints `true`. Screenshot `settings-02-slack-stored.png`. Clear it with `$AB click 'form:has(#secret-slack-token) button[type=button]'`; it returns to `No key stored.`

## Gotchas

- Every per-agent combobox is named `Default model`, and Linear and Slack both have `Save` and `Clear`. Use the ids (`#default-model-<agent>`, `#secret-slack-token`) instead of names.
- Shortcuts live in `clientSettings`, stored canonically (`mod` is Ctrl on Linux, recorded keys as `Mod+Shift+[KeyX]`). Assert on `clientSettings.get` and on the effect, not only on the rendered keys.
- After switching away from English, English accessible names no longer match. Switch back before running other recipes.
- Unpackaged runs use Chromium's mock keychain, so stored secrets are only obscured. Save dummy values only.
- Do not paste the user's real Linear or Slack secrets into a verification profile unless they asked for it.
