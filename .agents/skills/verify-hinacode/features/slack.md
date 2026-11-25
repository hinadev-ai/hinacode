# Slack

Settings > Integrations > Slack connects this machine to the developer's own Slack app over Socket Mode. A routine with a `Slack mention` trigger then starts a thread when an allowed member mentions the bot in an allowed channel, a later mention in the same Slack thread continues it, and the agent answers in that Slack thread with `reply`. The design is the `### Slack` section of `docs/features/2026-11-25-routine-triggers.md`. Connecting costs no agent turn. A mention starts one, so launch with `HINACODE_MOCK_CLAUDE=markdown` unless the check needs a real agent.

## Automated coverage

`src/main/services/slack/Slack.integration.test.ts` runs the real service, `Routines` and the agent runner against `fakeSlack.ts`: startup with stored tokens, a refused token, Disconnect, a mention that starts one thread with the eyes reaction, another member, another channel and a redelivered envelope, a later mention that continues the thread with the messages before it, the 20-message limit, a thread Slack will not hand over, and the post. `socket.integration.test.ts` and `api.integration.test.ts` cover a silent socket, a stalled handshake and Slack's refusals. `triggers.test.ts` holds the mention decoder. `mcp/server.integration.test.ts` covers `reply` into a Slack thread, its length limit, a disconnected Slack and Slack's refusal. No e2e scenario.

## Sub-features

- `connect` the two token fields and `Connect` show `Connected to <workspace> as @<bot>`.
- `refused` a wrong token shows `Could not connect: invalid_auth`.
- `restart` a relaunch connects with the stored tokens.
- `disconnect` forgets both tokens and shows `Not connected`.
- `start` an allowed member's mention in an allowed channel starts a thread from the routine with the mention quoted, and the bot adds an eyes reaction.
- `ignore` another member, another channel or a redelivered mention starts nothing and gets no reaction.
- `continue` a later mention in the same Slack thread reaches the same HinaCode thread with the earlier messages of the Slack thread quoted.
- `reply` the agent's `reply` lands in the Slack thread.

## How to get to it (user POV)

`Settings` > `Integrations` > `Slack`: link `Create Slack app`, textboxes `App token` and `Bot token`, buttons `Connect` and `Disconnect`. `Settings` > `Routines` > `New routine`: combobox `Trigger` `Slack mention`, then `From` (member ids) and `Channels` (channel ids).

## Driving it with fake-slack.ts

A real workspace is not needed. `fake-slack.ts` serves the Slack Web API and a Socket Mode socket on loopback, with a control port that plays Slack's side. Its workspace is `Acme`, its bot `@hinacode`, and its members are whatever ids you send as.

```sh
$S/fake-slack.ts 47911 >"$SHOTS/slack-fake.txt" 2>&1 &     # prints `api <url>`, `tokens <app> <bot>`, then every link, reaction and post
HINACODE_SLACK_API_URL=<api url> HINACODE_MOCK_CLAUDE=markdown $S/launch.sh $PORT $DATA
curl "http://127.0.0.1:47911/say?user=U2&text=<text>"                    # a message in C1 that mentions nobody, prints its ts
curl "http://127.0.0.1:47911/mention?user=U1&text=<text>"                # a mention in C1, prints its ts
curl "http://127.0.0.1:47911/mention?user=U1&thread=<ts>&text=<text>"    # a mention inside that message's thread
curl "http://127.0.0.1:47911/redeliver?user=U1&ts=<ts>&text=<text>"      # the same envelope again
curl http://127.0.0.1:47911/drop                                          # every socket closes
```

Preconditions:

- Instance launched as above, doctor passes, project `demo` on `$DATA/repo`.
- `ab() { agent-browser --session kkv-$PORT-slack --cdp $PORT "$@"; }`.

Checks:

- **Connect.** `Settings` > `Integrations`, fill `App token` and `Bot token` with the tokens the fake printed, `Connect`, wait for `Connected to Acme as @hinacode`. `slack-fake.txt` gains `link opened`. `grep -c xoxb-demo $DATA/settings.json $DATA/electron.log` prints 0 for both.
- **Start.** `New routine`, tab `No schedule`, `Trigger` `Slack mention`, `From` `U1`, `Channels` `C1`, `Create routine`. `/mention?user=U1&text=hi` prints a ts. `$S/rpc.ts $PORT routines.runs '{"id":"<id>","limit":5}'` shows one `event` run with a `threadId`, `threads.transcript` on it shows the routine prompt with the mention quoted as JSON, and the fake logs `reaction {"channel":"C1","timestamp":"<ts>","name":"eyes"}`.
- **Ignore.** `/mention?user=U2&text=hi` and `/mention?user=U1&channel=C2&text=hi` add no run and no reaction. `/redeliver` with the first mention's ts and text adds a `skipped` run and no reaction.
- **Continue.** Once the thread is idle, `/say?user=U2&thread=<ts>&text=lint fails`, then `/mention?user=U1&thread=<ts>&text=and now?`. `routines.runs` shows a second `started` run with the same `threadId`, and the thread's second message quotes `and now?` with `lint fails` under `context.thread`.
- **Reply.** `$S/rpc.ts $PORT mcp.connection '{"threadId":"<threadId>"}'`, then `$S/mcp-call.ts '<connection>' reply '{"text":"It is the lint step."}'` prints `Posted to https://acme.slack.com/archives/C1/p...`, and the fake logs one `post` with `"thread_ts":"<ts>"`.
- **Disconnect.** `Disconnect` shows `Not connected` and the fake logs `link closed`. `reply` again answers `Slack is not connected on this machine.`

## Gotchas

- `launch.sh` passes its environment to Electron, so set `HINACODE_SLACK_API_URL` on every launch, including the relaunch after `stop.sh`.
- With `HINACODE_MOCK_CLAUDE`, send a follow-up mention only after the thread is idle. The simulated agent refuses every steer, so a mention that lands on its running turn records a failed run.
- The fake pings each socket every five seconds. The app replaces a socket that hears nothing for thirty.
- Stop the fake yourself after `cleanup.sh`. It is not part of the instance's session.
