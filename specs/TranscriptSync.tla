---------------------------- MODULE TranscriptSync ----------------------------
(* How the renderer keeps one thread's transcript in sync with main: a `threads.transcript` snapshot plus
   pushes numbered per thread, over a channel that can lose pushes (docs/arch.md "Renderer sync: snapshot
   plus pushes"). *)
EXTENDS Naturals, Sequences

CONSTANTS
  MaxEvents,  \* events main publishes for the thread
  MaxLoads,   \* times the user opens the thread
  MaxLosses,  \* pushes the channel loses
  IpcOrdered  \* TRUE: pushes and rpc replies share one FIFO to the renderer. specs/probes/electron-ipc measures it:
              \* with Electron 44.9.3, 42 of 3000 replies overtook an earlier push and no push overtook another

\* An event is identified by its seq, so main's transcript is always 1..seq.
VARIABLES
  seq,        \* AgentRunner.ts transcriptSeqs, this thread's counter
  requests,   \* load ids whose threads.transcript rpc main has not run yet
  toRenderer, \* oldest first
  byThread,   \* stores/messages.ts byThread, the entry for the modeled thread
  loads,      \* how many times `fetchHistory` has started; also the latest load id
  losses,     \* pushes lost so far
  silent      \* seqs of pushes lost without a trace; a push that failed to decode is not here

vars == <<seq, requests, toRenderer, byThread, loads, losses, silent>>

Push(s)     == [type |-> "push", seq |-> s, decodes |-> TRUE]
Reply(l, s) == [type |-> "reply", load |-> l, seq |-> s]

\* Status "missing" stands for an absent key. `load` is the `loadId` token, `lastSeq` is `receivedSeqs`,
\* and `snapshotFrom` is a ghost.
Missing == [status |-> "missing", pending |-> <<>>, folded |-> <<>>,
            load |-> 0, snapshotFrom |-> 0, lastSeq |-> 0]

Range(n) == [k \in 1..n |-> k]

Contiguous(from, s) == \A k \in DOMAIN s : s[k] = from + k

TypeOK ==
  /\ seq \in 0..MaxEvents
  /\ loads \in 0..(MaxLoads + MaxLosses)
  /\ losses \in 0..MaxLosses
  /\ requests \subseteq 1..(MaxLoads + MaxLosses)
  /\ silent \subseteq 1..MaxEvents
  /\ byThread.status \in {"missing", "loading", "ready"}

Init ==
  /\ seq = 0
  /\ requests = {}
  /\ toRenderer = <<>>
  /\ byThread = Missing
  /\ loads = 0
  /\ losses = 0
  /\ silent = {}

-----------------------------------------------------------------------------
(* Main runs each step under the per-thread lock (AgentRunner.ts `exclusive`), so publishing and snapshotting
   are atomic with respect to each other. `webContents.send` in ipc.ts sendToWindows enqueues synchronously. *)

\* AgentRunner.ts publishTranscript
Publish ==
  /\ seq < MaxEvents
  /\ seq' = seq + 1
  /\ toRenderer' = Append(toRenderer, Push(seq + 1))
  /\ UNCHANGED <<requests, byThread, loads, losses, silent>>

\* AgentRunner.ts transcript, reply sent through ipcMain.handle in ipc.ts registerIpc
Transcript(l) ==
  /\ requests' = requests \ {l}
  /\ toRenderer' = Append(toRenderer, Reply(l, seq))
  /\ UNCHANGED <<seq, byThread, loads, losses, silent>>

\* The channel drops a push, or delivers one the renderer cannot decode.
Lose(i) ==
  /\ losses < MaxLosses
  /\ toRenderer[i].type = "push"
  /\ toRenderer[i].decodes
  /\ losses' = losses + 1
  /\ \/ /\ toRenderer' = SubSeq(toRenderer, 1, i - 1) \o SubSeq(toRenderer, i + 1, Len(toRenderer))
        /\ silent' = silent \cup {toRenderer[i].seq}
     \/ /\ toRenderer' = [toRenderer EXCEPT ![i].decodes = FALSE]
        /\ UNCHANGED silent
  /\ UNCHANGED <<seq, requests, byThread, loads>>

-----------------------------------------------------------------------------

\* stores/messages.ts `fetchHistory` up to the await, started by `load`, `reload` or a detected loss.
StartLoad ==
  /\ loads' = loads + 1
  /\ byThread' = [Missing EXCEPT !.status = "loading", !.load = loads + 1]
  /\ requests' = requests \cup {loads + 1}

\* stores/messages.ts `load`. Errors are not modeled, so `load` only runs on "missing".
Load ==
  /\ loads < MaxLoads
  /\ byThread.status = "missing"
  /\ StartLoad
  /\ UNCHANGED <<seq, toRenderer, losses, silent>>

\* stores/messages.ts `forget`: the history fell out of the recently viewed limit or its thread was removed.
Unload ==
  /\ byThread.status /= "missing"
  /\ byThread' = Missing
  /\ UNCHANGED <<seq, requests, toRenderer, loads, losses, silent>>

KeepLoad == UNCHANGED <<requests, loads>>

\* stores/messages.ts `fetchHistory` after the await. A gap among the buffered pushes starts another load.
Settle(r) ==
  IF byThread.status = "loading" /\ byThread.load = r.load
  THEN LET replay == SelectSeq(byThread.pending, LAMBDA s : s > r.seq) IN
       IF Contiguous(r.seq, replay)
       THEN /\ byThread' = [byThread EXCEPT
                              !.status = "ready",
                              !.folded = Range(r.seq) \o replay,
                              !.snapshotFrom = r.load,
                              !.lastSeq = r.seq + Len(replay)]
            /\ KeepLoad
       ELSE StartLoad
  ELSE UNCHANGED byThread /\ KeepLoad

\* stores/messages.ts `receive`. Folding is not idempotent (foldEvent.ts foldEvent appends a text_delta).
\* `lastSeq` counts deltas still waiting for the 100 ms flush, so the model folds on receipt.
Receive(p) ==
  CASE byThread.status = "loading" ->
         byThread' = [byThread EXCEPT !.pending = Append(@, p.seq)] /\ KeepLoad
    [] byThread.status = "ready" /\ p.seq = byThread.lastSeq + 1 ->
         byThread' = [byThread EXCEPT !.folded = Append(@, p.seq), !.lastSeq = p.seq] /\ KeepLoad
    [] byThread.status = "ready" /\ p.seq > byThread.lastSeq + 1 -> StartLoad
    [] OTHER -> UNCHANGED byThread /\ KeepLoad

\* lib/rpc.ts decodeOrReportLoss reads the thread id, and the main.tsx onPushEvent handler calls `reload` on
\* transcript.lost.
ReceiveUndecodable ==
  IF byThread.status /= "missing" THEN StartLoad ELSE UNCHANGED byThread /\ KeepLoad

\* Without IpcOrdered, pushes and replies are two FIFOs: the oldest message of either kind can go next.
Deliverable(i) ==
  IF IpcOrdered THEN i = 1
  ELSE \A j \in 1..(i - 1) : toRenderer[j].type /= toRenderer[i].type

Deliver(i) ==
  LET m == toRenderer[i] IN
  /\ toRenderer' = SubSeq(toRenderer, 1, i - 1) \o SubSeq(toRenderer, i + 1, Len(toRenderer))
  /\ CASE m.type = "reply" -> Settle(m)
       [] m.decodes -> Receive(m)
       [] OTHER -> ReceiveUndecodable
  /\ UNCHANGED <<seq, losses, silent>>

Next ==
  \/ Publish
  \/ \E l \in requests : Transcript(l)
  \/ \E i \in DOMAIN toRenderer : Lose(i)
  \/ Load
  \/ Unload
  \/ \E i \in DOMAIN toRenderer : Deliverable(i) /\ Deliver(i)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

NoDuplicateApply ==
  byThread.status = "ready" =>
    \A i, j \in DOMAIN byThread.folded : i /= j => byThread.folded[i] /= byThread.folded[j]

NeverFoldsPastAGap ==
  byThread.status = "ready" => byThread.folded = Range(Len(byThread.folded))

\* Only a silent loss with no later push can leave the transcript short, because nothing reveals it.
ConvergesAtQuiescence ==
  (byThread.status = "ready" /\ toRenderer = <<>> /\ requests = {})
    => \A s \in (Len(byThread.folded) + 1)..seq : s \in silent

StaleSnapshotNeverApplied ==
  byThread.status = "ready" => byThread.snapshotFrom = byThread.load
=============================================================================
