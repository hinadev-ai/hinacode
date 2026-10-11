# Perf harness

Measures the renderer and main process of a running kkcode instance over CDP. Start an isolated
instance first (see `.cursor/skills/verify-kkcode`), then:

```sh
node scripts/perf/seed.mjs <user-data-dir> <repo>            # project + threads of 5 to 200 turns
node scripts/perf/seed.mjs <user-data-dir> <repo> <projectId> # one 150-turn thread with 100 KB tool outputs
node scripts/perf/fatfill.mjs <worktree> 60000               # fake node_modules to time worktree removal
node scripts/perf/measure.mjs <port> <label> switch <threadId...>
node scripts/perf/measure.mjs <port> <label> scroll <threadId> [pxPerFrame]   # PROFILE=1 writes a .cpuprofile
node scripts/perf/measure.mjs <port> <label> settle <threadId>
node scripts/perf/analyze-profile.mjs .context/perf/<label>-scroll.cpuprofile
node scripts/perf/compare.mjs <before-label> <after-label>
```

Results land in `.context/perf/`. Reload the renderer after seeding: the sidebar only reads threads at boot.
