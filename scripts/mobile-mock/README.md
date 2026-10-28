# mobile-mock

A `hinacode serve` cloud for testing `apps/mobile` on an emulator or phone, filled with a scrubbed copy of your own threads so every screen shows real-shaped data. It never touches the real app's profile; it reads the database read-only.

```sh
scripts/mobile-mock/launch.sh /tmp/kk-mobile          # build, seed, serve on 127.0.0.1:48091, forward the port to every adb device
adb shell am start -a android.intent.action.VIEW -d '<the hinacode://connect URL it prints>'
```

Or paste the printed URL into the app's Pairing URL. Ctrl+C stops the cloud. Delete the profile directory before you seed again.

What the phone sees:

- The `hinacode` project with its transcripts, worktrees checked out from a local clone, pull request links and guides. The repo is public, so its pull requests load live through `gh`.
- Every other project renamed to `example-N` with an empty repo, and its threads kept as `thread-xxxxx` with no messages. Those projects are personal, and scrubbing free text cannot make them safe.
- Threads in each stored state: idle, limited, archived, pinned, untitled, created by another thread, plus a queued message and a snoozed and a woken thread the seed adds.
- Live states from the mocked Claude. Send a prompt to any Claude thread. `HINACODE_MOCK_CLAUDE=approvals` (the default) asks two approvals and a question, then streams a reply. `activity` runs background shells, `usage-limit` hits a limit. See `src/main/agents/claude/mock.ts` for the rest.
- Demo Linear tickets in the overview (`HINACODE_MOCK_LINEAR=1`).

What the seed removes: secrets and the relay, remote and environment settings; session ids; attachments, replaced by the app icon or a placeholder file; and in every string, tokens, keys, JWTs, emails, private IPs, Tailscale and tunnel hostnames, your home path and username, and long random-looking runs. It then fails if the seeded database still contains your home path, username, git email, project paths, environment hosts or tunnel hostname.

Codex and Muse Code are not mocked. A prompt sent to one of their threads runs the real CLI in the cloned worktree.
