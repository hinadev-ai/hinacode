# ui-states

Screenshots of the remote machine, device, browser, Tiny VM and pull request surfaces in every state they can be
in, for a UI review. States that need hardware or a network (a booted simulator, an offline cloud, a failing check)
come from fixtures, so one ordinary instance can show all of them.

The real renderer runs in plain Chromium with a stand-in `window.hinacode`:

- `server.ts` serves `main.ts` through Vite with the `apps/web` config, and forwards each read-only rpc to the
  break-ui instance by evaluating `window.hinacode.rpc(...)` over CDP. It streams that instance's push events over SSE.
  It refuses mutations, so a scenario never changes the instance's data.
- `main.ts` answers from the active scenario's overrides first, then from the instance. It narrows the sidebar to
  the `hinacode` project, turns on the `tinyVm` and `devices` experiments, and sets the theme, then imports
  `@/main.tsx`. `webview.ts` stands in for Electron's `<webview>` with an iframe.
- `check.ts` decodes every fixture with the response schemas in `src/shared/contract.ts` and fails on any mismatch.

```sh
scripts/break-ui/launch.sh 9241 /tmp/kk-breakui      # once; leave it running
scripts/ui-states/capture.sh it8-surfaces             # every scenario, Hina Light and Hina Dark
scripts/ui-states/capture.sh it8-surfaces '^pr-'      # only scenarios matching a regex
```

Shots land in `.context/hill/<label>/<scenario>-<light|dark>.png`, with an `.axe.json` per shot and a `summary.json`.
To look at one state by hand, run `node scripts/ui-states/server.ts` and open
`http://127.0.0.1:4431/?scenario=vm-floating&theme=hina-dark`.

## Adding a scenario

Add an entry to `scenarios.ts` named `<surface>-<state>`, and put any new data in `fixtures.ts`:

- `overrides` maps an rpc method to `{ result }`, `{ error }` or `"pending"` (never answers). Use
  `{ by: "url", replies: { ... } }` to answer per payload field.
- `remote` moves the `hinacode` project onto one of the fixture clouds, and `cloudOverrides` answers rpcs sent to it.
- `setup` gets an `App` to open a side panel view, a browser tab or a device tab, and to push events.
  `window.__uiState.push(event)` does the same from the console.
- `path` or `entry` start on another route, such as a settings page or the pull request window.
- `hover` names an element that the capture hovers instead of moving the pointer away, for hover cards.

Strings may use `$MAIN` (the main thread id), `$ORIGIN` (the server), `@ago:3h` (a time that long ago) and
`asset:phone.png` (a file in `assets/` as base64). Run `node scripts/ui-states/check.ts` after any change.
