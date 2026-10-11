# Settings

The settings page has five sections: `General` (language), `Models` (default model per agent), `Keybindings` (record, reset, conflict warning), `Integrations` (Linear API key, Slack user token, stored encrypted and never shown again), and `Automations` (see `automations.md`). Every change applies at once and survives a relaunch. No agent turn is needed.

## Sub-features

- `language` switches between `English` and `繁體中文`; the whole UI re-renders and the choice persists.
- `default-model` sets the default model per agent; the new thread dialog then preselects it.
- `keybinding-record` records a new chord for a command after `Record`; `Escape` cancels.
- `keybinding-conflict` warns `Also bound to <commands>. Only one of them will run.` when a chord is reused.
- `keybinding-reset` resets one command or `Reset all`.
- `keybinding-effect` the new chord runs the command and the old one no longer does.
- `secret-linear` stores, replaces and clears the Linear API key; the UI only ever says `A key is stored.` or `No key stored.`
- `secret-slack` the same for the Slack user token.

## How to get to it (user POV)

- Sidebar link `Settings`, or `Ctrl+,`. `Back to threads` returns.
- Section buttons in the `Settings sections` nav: `General`, `Models`, `Keybindings`, `Integrations`, `Automations` (in zh-TW the labels change; use the nav position or the zh-TW strings from `messages/zh-TW.json`).
- The `Switch language` command exists unbound; bind it in `Keybindings` to switch from anywhere.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes. A project `demo` exists for the default-model check.
- `AB="agent-browser --session kkv-$PORT-settings"`, connected.

- **Open.** Press `Control+,`. The heading `Settings` and `General` show. Screenshot `settings-01-general-en.png`.
- **Language.** `$AB click '#settings-locale'`, `$AB wait '[role=option]'`, `$AB find role option click --name "繁體中文" --exact`. The page re-renders in Traditional Chinese, including the sidebar. Screenshot `settings-02-zh-TW.png`. `$S/rpc.mjs $PORT settings.get` shows `"locale": "zh-TW"`. Relaunch (`stop.sh`, `launch.sh --no-build`, reconnect): the app starts in zh-TW (`settings-03-after-relaunch-zh-TW.png`). Switch back to `English`.
- **Default model.** Open `Models`. Each agent has a combobox labelled with the agent name; `$AB find role combobox click --name "Claude Code"`, pick `Sonnet 5.5`, click that section's `Save`; `Saved` appears. Go `Back to threads`, open `New thread in demo`: `#thread-model` already reads `Sonnet 5.5`. Screenshot `settings-04-new-thread-default-model.png`.
- **Record a keybinding.** Open `Keybindings`, click `Record a shortcut for New thread` (`--exact`). The row reads `Press a shortcut…`. Press `Control+Alt+t`. The row shows the keycaps `Ctrl` `Alt` `T` (accessible name `Ctrl+Alt+T`). Screenshot `settings-05-keybinding-recorded.png`. `settings.get` shows `"thread.new": "mod+alt+t"`.
- **Effect.** `Back to threads`, press `Control+Alt+t`: the `New thread` dialog opens. Cancel it. Press `Control+n`: nothing opens.
- **Conflict.** Record `Control+b` for `New thread` (already `Show or hide sidebar`). The conflict warning names `Show or hide sidebar`. Screenshot `settings-06-conflict.png`. Click `Reset New thread to its default shortcut`; the row shows `Ctrl N` again.
- **Integrations.** Open `Integrations`. Fill `Linear API key` with `lin_api_test_not_real` and save; the status reads `A key is stored.` and the field does not show the key. Screenshot `settings-07-linear-stored.png`. `$S/rpc.mjs $PORT secrets.has '{"name":"linear.apiKey"}'` prints `true`. Click `Clear`; the status reads `No key stored.` and `secrets.has` prints `false`. Repeat for `Slack user token` with secret name `slack.token`.

## Gotchas

- Chords are stored canonically (`mod` is Ctrl on Linux). Assert on the stored value and on the effect, not only on the rendered keys.
- While a row is recording, every key press is captured, including `Control+,`. Press `Escape` to leave recording before navigating.
- After switching to zh-TW, English accessible names no longer match. Switch back before running other recipes, or look names up in `messages/zh-TW.json`.
- Secrets are encrypted with Electron safeStorage. On Xvfb without a keyring safeStorage may fall back to a weaker backend; that is environment, not a kkcode bug, but note it if `secrets.set` errors.
- Do not paste the user's real Linear or Slack secrets into a verification profile unless they asked for it.
