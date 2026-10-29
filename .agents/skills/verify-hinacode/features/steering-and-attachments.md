# Steering and attachments

While a turn runs, a user can steer it with a message the agent receives mid-turn (Claude as a priority message, Codex through `turn/steer`), or queue a follow-up that sends when the turn ends. A user can also attach images and files to a message by paste, drop, or the attach button; images go to the model, other files are passed by absolute path. Steering costs agent turns; the attachment steps up to sending need none.

## Automated coverage

`e2e/features/responsive-composer.feature` (`Image attachments leave room to edit and send an enlarged draft`) pastes images into `Message` and expects a `Remove image-<n>.png` chip per image. `e2e/features/queued-messages.feature` (`A failed steer restores the queued message beside the current draft`) seeds a queued message with an attachment, clicks `Steer now` on an archived thread, and expects the text and both chips back in the composer and `Queued messages` gone. `src/main/ipc.integration.test.ts` (`queued messages over rpc`) covers `threads.queue`.

## Sub-features

- `attach-paste` (e2e) pastes an image into the composer; a chip appears under `Attachments to send`.
- `queue-restore` (e2e) a failed `Steer now` puts the queued message back in the composer.
- `steer-claude` clicks `Steer` while a Claude turn runs; the steer shows as a user message inside the turn and the reply follows it.
- `steer-codex` does the same for Codex.
- `queue` `Enter` (or `Queue`) while running holds the message in `Queued messages` (`threads.queue`); it sends when the turn ends.
- `steer-idle` sending while idle starts a normal turn.
- `attach-drop` drops a file on the composer.
- `attach-button` opens the native multi-file picker (`Attach files`).
- `attach-remove` removes a pending chip with `Remove <name>`.
- `attach-render` shows sent images inline (`[title="Open <name>"]`) and files with `[title="Show <name> in folder"]`.
- `attach-model` the model actually sees the image or reads the file.

## How to get to it (user POV)

- While the header reads `Running`, the placeholder starts with `Queue a follow-up…` (`Enter` queues, `Mod+Enter` steers), and the composer shows `Stop`, `Queue` and `Steer`.
- `Queued messages` above the composer has `Steer now`, `Edit in the composer` and `Remove from the queue` per message.
- Paste (`Ctrl+V`) or drop onto the `Message` box, or click `Attach files`.

## Driving it with agent-browser

Preconditions:

- A Claude thread (`Sonnet 5.5`) and a Codex thread exist in project `demo` on `$DATA/repo`, both `Idle`, with `Access` set to `Supervised` (Claude) and `Auto` (Codex) so the commands ask first.
- `AB="agent-browser --session kkv-$PORT-steering-and-attachments"`, connected.

- **Steer Claude.** Send `Use the Bash tool to run: python3 -c 'import time; time.sleep(20)', then say done`, `Allow` it. While `Running`, fill `Message` with `Actually, also say the word steered at the end` and click `Steer` (`--exact`). Screenshot `steering-and-attachments-01-steer-inline.png`: the steer appears as a user message inside the running turn. After the turn the reply contains `steered`. Screenshot `steering-and-attachments-02-steer-done.png`.
- **Steer Codex.** Same on the Codex thread with `Run the shell command: python3 -c 'import time; time.sleep(20)', then say done`. Screenshots `-03-` and `-04-`.
- **Queue.** While a turn runs, fill `Message` and press `Enter`. `Queued messages` lists it; after the turn it sends as the next turn.
- **Paste and send an image.** Focus `Message` and dispatch a paste with a real `File`: `$AB eval "(()=>{const b=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([b],'red.png',{type:'image/png'}));document.querySelector('textarea[aria-label=Message]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))})()"`. Fill `Message` with `What color is the attached image? One word.` and press `Enter`. The user message shows the image (`[title="Open red.png"]`); the reply says red. Screenshot `steering-and-attachments-05-image-reply.png`.
- **Drop and remove a file.** Dispatch a `drop` on the textarea the same way with `new File(["hello from a file"], "note.txt", {type: "text/plain"})` and `new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})`. A chip `note.txt` appears; `Remove note.txt` removes it. Drop it again and send `Read the attached file and quote it.` The reply quotes `hello from a file`.
- **Side effects.** `ls $DATA/attachments/<threadId>/` lists `<id>-red.png` and `<id>-note.txt`; `threads.transcript` shows `attachment` parts on the user messages.

## Gotchas

- `fetch('data:...')` fails with `Failed to fetch` inside the app; build bytes with `Uint8Array.from(atob('...'), c => c.charCodeAt(0))`.
- The Claude Code CLI rejects a standalone `sleep N`, so the turn finishes at once. Keep a turn busy with `python3 -c 'import time; time.sleep(N)'`.
- Default access is `Full access`, which never shows `Allow`. Set `Access` first when a step clicks it.
- `Attach files` opens a native GTK picker that CDP cannot see. Report `attach-button` as not driven, or stage directly with `$S/rpc.ts $PORT attachments.stage '{"threadId":"<id>","source":{"path":"/abs/file"}}'` and say so.
- Files built in `eval` have no disk path (`pathForFile` returns `""`), so they are staged from a data URL. Real drops from a file manager are staged by path. These are different code paths; say which one you proved.
- `Open <name>` and `Show <name> in folder` are `title` attributes, not accessible names; select them with CSS.
- Observed 2026-10-29: after a steer while a Claude Bash command ran, `Stop` and `Ctrl+Shift+C` did not interrupt; the 90-second command finished and the steered reply followed. Without a steer, `Stop` interrupted a running command at once.
- Steering with attachments was not proven in earlier runs; treat it as a separate sub-feature if you test it.
