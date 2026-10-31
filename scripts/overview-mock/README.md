# overview-mock

Demo data for the thread overview panel: environment, setup script, actions and sub-agents.

```sh
pnpm dev:overview        # seeds /tmp/kk-overview once, then runs the app with the mocked Claude
rm -rf /tmp/kk-overview  # start over
```

The seed creates a `demo-web` git repository with a `kk/fix-login` worktree, a setup script with its log, three actions and four threads, one pinned. "Fix login redirect" links three public HinaCode pull requests, one open and two merged; their status loads through `gh`.

Send any message in a thread. `HINACODE_MOCK_CLAUDE=subagents` then starts six sub-agents: two running, two completed, one failed and one stopped. The running ones call a new tool every two seconds, and "Audit the composer" completes after four. Stop on a running row stops it, and each row opens its own transcript. Stop the turn to end it.
