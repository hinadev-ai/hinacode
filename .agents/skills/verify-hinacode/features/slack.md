# Slack

Settings > Experimental > Slack connects this machine to a Slack app over Socket Mode and pairs the Slack user who may hand work over. That user's mention or direct message then starts a run of the routine picked there. The design is `docs/features/2026-11-17-slack-conversations.md`. Connecting and pairing cost no agent turn. A mention starts one, so launch with `HINACODE_MOCK_CLAUDE=markdown` and give the routine a Claude model unless the check needs a real agent.

## Automated coverage

`src/main/services/slack/Slack.integration.test.ts` and `socket.integration.test.ts` run the real service against `fakeSlack.ts`: connect, a refused token, a revoked token, the replacement after a `disconnect` frame, a dropped or silent socket, pairing and Disconnect. `SlackAsks.integration.test.ts` runs a mention through the real `Routines`, `Threads` and agent runner: one run with the Slack thread quoted, the link, the reaction, a redelivered mention, another user, a linked thread, a direct message, no routine and a Slack refusal. `slackInbound.test.ts` and `slackPrompt.test.ts` hold the decision table and the transcript. `SlackSettings.component.test.tsx` covers the settings group and `ThreadOverview.component.test.tsx` the Slack link. No e2e scenario.

## Sub-features

- `connect` the switch, the two token fields, `Connected to <workspace> as @<bot>`.
- `refused` a wrong token shows `Could not connect: invalid_auth` and keeps the form.
- `pair` `Pair` shows a code; the code sent to the bot in a direct message shows `Paired with <name>`, and the bot adds a check reaction.
- `outsider` the code sent by a user of another workspace is spent and pairs nobody.
- `reconnect` a dropped socket shows `Connecting`, then connects again. A refresh request opens a replacement first.
- `restart` a relaunch connects with the stored tokens and keeps the paired user.
- `revoked` an app token revoked while connected shows `Could not connect: invalid_auth`, and the app keeps running.
- `disconnect` forgets both tokens and the paired user.
- `routine` the `Routine` select picks what a mention runs.
- `start` the paired user's mention starts a thread from that routine with the Slack thread quoted, and the bot adds an eyes reaction.
- `refuse` anyone else, a missing routine or a Slack thread that already has a thread gets a note only the sender sees, and nothing starts.
- `link` the thread shows a Slack link that opens the Slack thread, with Unlink.

## How to get to it (user POV)

`Settings` > `Experimental` > switch `Slack`. Then link `Create Slack app`, textboxes `App token` and `Bot token`, buttons `Connect`, `Disconnect`, `Pair` or `Pair again`, and the code in `#settings-slack-pairing-code`.

## Driving it with fake-slack.ts

A real workspace is not needed. `fake-slack.ts` serves the Slack Web API and a Socket Mode socket on loopback, with a control port that plays Slack's side.

```sh
$S/fake-slack.ts 47911 >"$SHOTS/slack-fake.txt" 2>&1 &     # prints `api <url>`, `tokens <app> <bot>`, then every link, reaction and note
HINACODE_SLACK_API_URL=<api url> $S/launch.sh $PORT $DATA
curl "http://127.0.0.1:47911/dm?user=U1&text=<code>"       # U1 and U2 are workspace members, U9 belongs to another workspace
curl "http://127.0.0.1:47911/say?user=U2&text=<text>"      # a message in C1 that reaches nobody, prints its ts
curl "http://127.0.0.1:47911/mention?user=U1&thread=<ts>&text=<text>"   # a mention in that message's thread
curl http://127.0.0.1:47911/refresh                        # Slack asks for a new connection
curl http://127.0.0.1:47911/drop                           # every socket closes
curl http://127.0.0.1:47911/revoke                         # apps.connections.open answers invalid_auth from now on
```

Checks:

- **Connect.** Fill the two tokens the fake printed, `Connect`, wait for `Connected to Acme as @hinacode`. `slack-fake.txt` gains `link opened`.
- **Pair.** `Pair`, read the code with `ab eval 'document.getElementById("settings-slack-pairing-code").value'`, send it as `U9` and see `Pair` come back with no owner, then pair again and send it as `U1`. `$S/rpc.ts $PORT slack.status null` shows the owner, and the fake logs the reaction.
- **Secrets stay in main.** `grep -c <token> $DATA/settings.json $DATA/electron.log` prints 0 for both.
- **Generic secrets.** `$S/rpc.ts $PORT secrets.clear '{"name":"slack.botToken"}'` shows `Not connected` and the fake logs `link closed`. `secrets.set` with the same token connects again and keeps the paired user.
- **Revoked.** `/revoke`, then `/drop`. The status line turns red, and `grep -ci "unhandled\|uncaught" $DATA/electron.log` prints 0.

## Gotchas

- `launch.sh` passes its environment to Electron, so set `HINACODE_SLACK_API_URL` on every launch, including the relaunch after `stop.sh`.
- A relaunch does not reopen `Experimental`. It lands on `General` or on the thread list, so go to `Settings` > `Experimental` again before waiting for Slack text.
- The fake pings each socket every five seconds. The app replaces a socket that hears nothing for thirty.
- Stop the fake yourself after `cleanup.sh`. It is not part of the instance's session.
