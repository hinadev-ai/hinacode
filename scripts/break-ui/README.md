# break-ui fixture

Worst-case data for the `break-ui` skill (`.agents/skills/break-ui/`), shaped like what real users produce:

- Thread titles, branches, paths and URLs too long for any column, plus unbreakable identifiers
- Japanese, Arabic (RTL) and emoji titles, and a one-letter title
- An image attachment whose file is gone, and a 1.2 GB file attachment
- A queued message, a usage limit, an agent question with long options, and colored terminal output
- PR links to repositories that do not exist, so the lookups fail
- Automations, agent accounts and remote environments with long names and errors
- A project with no threads and one with 300

```sh
scripts/break-ui/launch.sh 9241 /tmp/kk-breakui     # build, seed, start; prints "hinacode ready: ..."
agent-browser --session kkv-9241-breakui --cdp 9241 screenshot "$PWD/.context/shots/break-ui.png"
.agents/skills/verify-hinacode/scripts/cleanup.sh 9241 /tmp/kk-breakui kkv-9241-breakui
```

When you add a field to the UI, add its worst case to `seed.mjs` too. The schema it writes follows
`src/main/db/migrations/`, so update it when a migration renames or drops a column.
