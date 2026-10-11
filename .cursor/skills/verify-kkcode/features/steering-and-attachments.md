# Steering and attachments

While a turn runs, a user can steer it by sending another message, which the agent receives mid-turn (Claude as a priority message, Codex through `turn/steer`). A user can also attach images and files to a message by paste, drop, or the attach button; images go to the model, other files are passed by absolute path. Every step costs agent turns.

## Sub-features

- `steer-claude` sends a message while a Claude turn runs; the assistant message splits at the steer and the reply follows the new instruction.
- `steer-codex` does the same for Codex.
- `steer-idle` sending while idle starts a normal turn.
- `attach-paste` pastes an image into the composer; a chip appears under `Attachments to send`.
- `attach-drop` drops a file on the composer.
- `attach-button` opens the native multi-file picker (`Attach files`).
- `attach-remove` removes a pending chip with `Remove <name>`.
- `attach-render` shows sent images inline (`Open <name>`) and files with `Show <name> in folder`.
- `attach-model` the model actually sees the image or reads the file.

## How to get to it (user POV)

- While the header reads `Running`, the composer placeholder becomes `Steer the agent… Enter sends while it works.` and the send button is `Steer`.
- Paste (`Ctrl+V`) or drop onto the `Message` textbox, or click `Attach files`.

## Driving it with agent-browser

Preconditions:

- A Claude thread (`Sonnet 5.5`) and a Codex thread exist in project `demo` on `$DATA/repo`, both `Idle`.
- `AB="agent-browser --session kkv-$PORT-steering-and-attachments"`, connected.
- A small PNG exists at `$DATA/red.png`, for example `node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==","base64"))' $DATA/red.png` (1x1 red pixel).

- **Steer Claude.** Send `Use the Bash tool to run: sleep 20, then say done`, `Allow` it. While `Running`, fill `Message` with `Actually, also say the word steered at the end` and click `Steer` (`--exact`). Screenshot `steering-and-attachments-01-steer-inline.png`: the steer appears as a user message inside the running turn. After the turn the reply contains `steered`. Screenshot `steering-and-attachments-02-steer-done.png`.
- **Steer Codex.** Same on the Codex thread with `Run the shell command: sleep 20, then say done`. Screenshots `-03-` and `-04-`.
- **Paste an image.** Focus `Message` and dispatch a paste with a real `File`: `$AB eval "(async()=>{const b=await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==')).blob();const dt=new DataTransfer();dt.items.add(new File([b],'red.png',{type:'image/png'}));document.querySelector('textarea[aria-label=Message]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))})()"`. A chip `red.png` appears in `Attachments to send`. Screenshot `steering-and-attachments-05-pending.png`.
- **Send with the image.** Fill `Message` with `What color is the attached image? One word.` and press `Enter`. The user message shows the image (`Open red.png`); the reply says red. Screenshot `steering-and-attachments-06-image-reply.png`.
- **Drop a file.** Dispatch a `drop` event the same way with `new File(["hello from a file"], "note.txt", {type: "text/plain"})` on the textarea (`new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})`). A chip `note.txt` appears; `Remove note.txt` removes it (`attach-remove`); drop it again and send `Read the attached file and quote it.` The reply quotes `hello from a file`.
- **Side effects.** `ls $DATA/attachments/<threadId>/` lists `<id>-red.png` and `<id>-note.txt`; `messages.list` shows `attachment` parts on the user messages.

## Gotchas

- `Attach files` opens a native GTK picker that CDP cannot see. Report `attach-button` as not driven, or stage directly with `$S/rpc.mjs $PORT attachments.stage '{"threadId":"<id>","source":{"path":"/abs/file"}}'` and say so.
- Files built in `eval` have no disk path (`pathForFile` returns `""`), so they are staged from a data URL. Real drops from a file manager are staged by path. These are different code paths; say which one you proved.
- Claude does not interrupt a running Bash command when steered; the steer applies after the command finishes.
- Steering with attachments was not proven in earlier runs; treat it as a separate sub-feature if you test it.
