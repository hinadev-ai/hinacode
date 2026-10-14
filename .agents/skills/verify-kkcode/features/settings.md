# Settings

The settings page has five sections: `General` (language), `Models` (default model per agent and thread naming model), `Keybindings` (record, reset, conflict warning), `Integrations` (GitHub sign-in state, Linear API key, Slack user token, stored encrypted and never shown again), and `Automations` (see `automations.md`). Every change applies at once and survives a relaunch. No agent turn is needed.

## Automated coverage

`e2e/features/settings.feature`: switching to 繁體中文 and starting in it, the Claude default model preselecting in the new thread composer, recording a shortcut and using it, Escape cancelling a recording, the conflict warning and reset, a saved shortcut replacing the default after a restart, and the Linear API key being stored, reported as stored, and cleared.

## Sub-features

- `language` (e2e) switches between `English` and `繁體中文`; the whole UI re-renders and the choice persists.
- `default-model` (e2e for Claude) sets the default model per agent; the new thread composer then preselects it.
- `keybinding-record`, `keybinding-conflict`, `keybinding-reset`, `keybinding-effect` (e2e).
- `secret-linear` (e2e) stores, replaces and clears the Linear API key; the UI only ever says `A key is stored.` or `No key stored.`
- `default-model-codex` the same picker for Codex, fed by the live `codex` model list.
- `secret-slack` the same write-only field for the Slack user token (`slack.token`).
- `gh-status` the GitHub row reads the `gh` sign-in state; see `mcp-and-pull-requests.md`.

## How to get to it (user POV)

- Sidebar link `Settings`, or `Ctrl+,`. `Back to threads` returns.
- Section buttons in the `Settings sections` nav: `General`, `Models`, `Keybindings`, `Integrations`, `Automations`.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes, project `demo` exists, `codex` is installed for the Codex model list.
- `AB="agent-browser --session kkv-$PORT-settings"`, connected.

- **Codex default model.** Open `Models`. `$AB find role combobox click --name "Codex"`, `$AB wait '[role=option]'`, pick the first option. `$S/rpc.mjs $PORT settings.get` shows it under `defaultModel.codex`, and an automation switched to Codex preselects it. Screenshot `settings-01-codex-default.png`. If `codex` cannot list models the field is a free-text id with a notice; report that instead.
- **Slack token.** Open `Integrations`, fill `Slack user token` with `xoxp-test-not-real`, `Save`. The status reads `A key is stored.`, `$S/rpc.mjs $PORT secrets.has '{"name":"slack.token"}'` prints `true`; `Clear` returns it to `No key stored.` Screenshot `settings-02-slack-stored.png`.

## Gotchas

- Chords are stored canonically (`mod` is Ctrl on Linux). Assert on the stored value and on the effect, not only on the rendered keys.
- After switching to zh-TW, English accessible names no longer match. Switch back before running other recipes.
- Secrets are encrypted with Electron safeStorage. On Xvfb without a keyring safeStorage falls back to plaintext with a warning in the log; that is environment, not a kkcode bug.
- Do not paste the user's real Linear or Slack secrets into a verification profile unless they asked for it.
