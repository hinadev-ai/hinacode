# docs

What the code can't show: why a feature looks the way it does, which decisions are expensive to undo, and how to run and repair the app.

| Path          | What goes in it                                       | File name                    |
| ------------- | ----------------------------------------------------- | ---------------------------- |
| `arch.md`     | How the codebase fits together, with mermaid diagrams |                              |
| `features/`   | The design of one feature, written before building it | `YYYY-MM-DD-feature-name.md` |
| `adr/`        | One architecture decision that is costly to reverse   | `NNNN-title.md`              |
| `operations/` | Runbooks: releasing, debugging, recovering user data  | `task.md`                    |

Each folder has a `TEMPLATE.md`. Copy it, keep the sections that earn their place, and delete the rest.

- Write in plain, specific English. A reader should finish in five minutes.
- When the code changes a documented behavior, update the doc in the same PR.
- Once a feature has been removed, delete its doc. Keep ADRs and mark them `Superseded by NNNN`.
