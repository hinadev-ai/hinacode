# Settings

The settings page has ten pages in one list: `General` (machine setup, language, version and update), `Appearance`, `Notifications`, `Keybindings` (record, reset, conflict warning), `Providers` (accounts, default model, presets and auto-compact per agent, one default access, the text generation model, pull request guide), `Worktrees` (the worktree list, `Worktree root`, the archive switches), `Integrations` (GitHub sign-in state, Linear API key, stored encrypted and never shown again), `Routines` (see `routines.md`), `Connections` (environments and the phone listener, see `remote.md`) and `Experimental` (Tiny VM, Devices). `Providers`, `Worktrees`, `Integrations`, `Routines` and `Experimental` follow the `Editing settings for` picker once a cloud exists. Selects and switches apply at once; text fields apply on `Save` or `Enter`. Everything survives a relaunch. No agent turn is needed.

## Automated coverage

`e2e/features/settings.feature`: switching to 繁體中文 and starting in it, the Claude default model preselecting in the new thread composer, `Ctrl+B` hiding and showing the sidebar, recording a shortcut and using it, Escape cancelling a recording, the conflict warning and reset, a saved shortcut replacing the default after a restart, the Linear API key being stored, reported as stored, and cleared, and `Archive settings are saved`. `e2e/features/navigation.feature`: `Escape leaves settings for the thread you came from` and `Escape that closes the sidebar overlay stays in settings`. `e2e/features/agent-accounts.feature`: `The models tab shows who Claude Code is signed in as`. `e2e/features/appearance.feature` and `notifications.feature` cover those pages.

## Sub-features

- `language` (e2e) switches between `English`, `繁體中文`, `简体中文` and `日本語`; the whole UI re-renders and the choice persists.
- `default-model` (e2e for Claude) sets the default model per agent; the new thread composer then preselects it.
- `keybinding-record`, `keybinding-conflict`, `keybinding-reset`, `keybinding-effect` (e2e).
- `secret-linear` (e2e) stores, replaces and clears the Linear API key; the UI only ever says `A key is stored.` or `No key stored.`
- `archive` (e2e) the two archive switches on `Worktrees` persist.
- `leave` (e2e) `Escape` returns to the thread you came from; so does `Back to threads`.
- `account-claude` (e2e) Providers shows the Claude Code sign-in.
- `theme` Appearance picks a theme such as `Hina Light`; it is a client setting.
- `default-model-codex` the same picker for Codex, fed by the live `codex` model list.
- `gh-status` the GitHub row reads the `gh` sign-in state; see `mcp-and-pull-requests.md`.

## How to get to it (user POV)

- Title bar link `Settings`, or `Mod+,`. `Back to threads` or `Escape` returns; `Escape` does nothing while focus is in a text field.
- Page buttons in the `Settings sections` nav, plus its `Search settings` box.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes, project `demo` exists, `codex` is installed for the Codex model list.
- `ab() { agent-browser --session kkv-$PORT-settings --cdp $PORT "$@"; }`.

- **Codex default model.** `ab find role button click --name "Providers" --exact`, `ab wait '#default-model-codex'`, `ab click '#default-model-codex'`, `ab wait '[role=option]'`, `ab find role option click --name "<model>" --exact`, `ab wait '#default-model-codex[aria-expanded="false"]'`. `$S/rpc.ts $PORT settings.get` shows it under `defaultModel.codex`, and an automation switched to Codex preselects it. Screenshot `settings-01-codex-default.png`. If `codex` cannot list models the field is a free-text id with a notice; report that instead.
- **Theme.** `Appearance`, then `ab find text "Hina Light" click --exact`. The theme radios are hidden inputs: `find role radio click` reports Done and changes nothing. `$S/rpc.ts $PORT clientSettings.get` shows `"theme": "hina-light"`; `settings.get` does not hold it.

## Gotchas

- Picking a model or access on a draft thread also sets that agent's default, so `defaultModel` may already be set before you touch Settings.
- Every per-agent combobox is named `Default model`, and Linear has `Save` and `Clear`. Use the ids (`#default-model-<agent>`, `#secret-linear-apiKey`) instead of names.
- Shortcuts live in `clientSettings`, stored canonically (`mod` is Ctrl on Linux and Cmd on macOS, recorded keys as `Mod+Shift+[KeyX]`). Assert on `clientSettings.get` and on the effect, not only on the rendered keys.
- After switching away from English, English accessible names no longer match. Switch back before running other recipes.
- Unpackaged runs use Chromium's mock keychain, so stored secrets are only obscured. Save dummy values only.
- Do not paste the user's real Linear secret into a verification profile unless they asked for it.
