# site-demo

The window on the website is the real HinaCode renderer, built for the browser from `site/app/`. On the site it replays `site/app/recording.json`, a session recorded against a real `hinacode serve` cloud with every agent mocked by the `demo` scenario (`src/main/agents/claude/fixtures/demo.ts`). Record it again when the app's UI or rpc contract changes.

```sh
node scripts/site-demo/seed.ts /tmp/kk-site-demo
pnpm build:server
HINACODE_USER_DATA=/tmp/kk-site-demo HINACODE_MOCK_AGENTS=demo HINACODE_SERVE_AUTO_UPDATE=0 \
  node out/server/daemon.js serve --host 127.0.0.1 --port 48199   # prints the token in its pairing URL
node scripts/site-demo/history.ts 127.0.0.1:48199 <token>         # gives the older threads a finished turn, prints thread ids
pnpm exec vite --config vite.site-app.config.ts                   # serves the app on :4419
scripts/site-demo/record.sh 127.0.0.1:48199 <token> <id of "Fix the flaky login test"> /tmp/kk-site-demo/recording.json
node scripts/site-demo/finalize.ts /tmp/kk-site-demo/recording.json /tmp/kk-site-demo
```

- The seed makes three git repositories, three worktrees with real changes, and six threads. Two threads link public HinaCode pull requests, so their Pull requests tab shows real GitHub data through `gh`.
- `record.sh` drives the app with `agent-browser`: it opens every thread and the tabs the site should answer, sends the CSV and login prompts, allows the command and answers the question. `site/app/live.ts` records every rpc call and pushed event on the way.
- `finalize.ts` replaces the data directory with `/Users/you/code` and the signed-in GitHub login with `you`.
- `site/app/replay.ts` answers each call with the latest matching recorded response, plays both prompts when the window scrolls into view, then waits for the visitor's Allow and answer before releasing the rest. Anything the recording cannot answer returns an error that says it is a recording.
