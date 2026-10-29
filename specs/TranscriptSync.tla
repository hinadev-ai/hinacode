---------------------------- MODULE TranscriptSync ----------------------------
(* How the renderer keeps one thread's transcript in sync with main: a `threads.transcript` snapshot plus
   `seq`-numbered pushes (docs/arch.md "Renderer sync: snapshot plus pushes"). *)
EXTENDS Naturals, Sequences

CONSTANTS
  MaxEvents,  \* events main publishes for the thread
  MaxLoads,   \* times the user opens the thread
  IpcOrdered  \* TRUE: pushes and rpc replies share one FIFO to the renderer

\* An event is identified by its seq, so main's transcript is always 1..seq.
VARIABLES
  seq,        \* AgentRunner.ts:263
  requests,   \* load ids whose threads.transcript rpc main has not run yet
  toRenderer, \* oldest first
  byThread,   \* messages.ts:27, the entry for the modeled thread
  loads       \* how many times `load` has started; also the latest load id

vars == <<seq, requests, toRenderer, byThread, loads>>

Push(s)     == [type |-> "push", seq |-> s]
Reply(l, s) == [type |-> "reply", load |-> l, seq |-> s]

\* Status "missing" stands for an absent key. `load` is the `loadId` token and `snapshotFrom` is a ghost.
Missing == [status |-> "missing", pending |-> <<>>, folded |-> <<>>,
            load |-> 0, snapshotFrom |-> 0, snapshotSeq |-> 0]

Range(n) == [k \in 1..n |-> k]

TypeOK ==
  /\ seq \in 0..MaxEvents
  /\ loads \in 0..MaxLoads
  /\ requests \subseteq 1..MaxLoads
  /\ byThread.status \in {"missing", "loading", "ready"}

Init ==
  /\ seq = 0
  /\ requests = {}
  /\ toRenderer = <<>>
  /\ byThread = Missing
  /\ loads = 0

-----------------------------------------------------------------------------
(* Main runs each step under the per-thread `exclusive` lock (AgentRunner.ts:278-284), so publishing and
   snapshotting are atomic with respect to each other. `webContents.send` (ipc.ts:360) enqueues synchronously. *)

\* AgentRunner.ts:296 publishTranscript
Publish ==
  /\ seq < MaxEvents
  /\ seq' = seq + 1
  /\ toRenderer' = Append(toRenderer, Push(seq + 1))
  /\ UNCHANGED <<requests, byThread, loads>>

\* AgentRunner.ts:666-684, reply sent through ipcMain.handle, ipc.ts:342-346
Transcript(l) ==
  /\ requests' = requests \ {l}
  /\ toRenderer' = Append(toRenderer, Reply(l, seq))
  /\ UNCHANGED <<seq, byThread, loads>>

-----------------------------------------------------------------------------

\* messages.ts `load` -> `fetchHistory` up to the await. Errors are not modeled, so `load` only runs on "missing".
Load ==
  /\ loads < MaxLoads
  /\ byThread.status = "missing"
  /\ loads' = loads + 1
  /\ byThread' = [Missing EXCEPT !.status = "loading", !.load = loads + 1]
  /\ requests' = requests \cup {loads + 1}
  /\ UNCHANGED <<seq, toRenderer>>

\* messages.ts `forget`: the history fell out of the recently viewed limit or its thread was removed.
\* `reload` after a cloud reconnect is Unload followed by Load.
Unload ==
  /\ byThread.status /= "missing"
  /\ byThread' = Missing
  /\ UNCHANGED <<seq, requests, toRenderer, loads>>

\* messages.ts `fetchHistory` after the await, through `settle`
Settle(r) ==
  IF byThread.status = "loading" /\ byThread.load = r.load
  THEN byThread' = [byThread EXCEPT
                      !.status = "ready",
                      !.folded = Range(r.seq) \o SelectSeq(byThread.pending, LAMBDA s : s > r.seq),
                      !.snapshotFrom = r.load,
                      !.snapshotSeq = r.seq]
  ELSE UNCHANGED byThread

\* messages.ts `receive`. Folding is not idempotent (foldEvent.ts:11 text_delta appends).
Receive(p) ==
  CASE byThread.status = "loading" ->
         byThread' = [byThread EXCEPT !.pending = Append(@, p.seq)]
    [] byThread.status = "ready" /\ p.seq > byThread.snapshotSeq ->
         byThread' = [byThread EXCEPT !.folded = Append(@, p.seq)]
    [] OTHER -> UNCHANGED byThread

\* Without IpcOrdered, pushes and replies are two FIFOs: the oldest message of either kind can go next.
Deliverable(i) ==
  IF IpcOrdered THEN i = 1
  ELSE \A j \in 1..(i - 1) : toRenderer[j].type /= toRenderer[i].type

Deliver(i) ==
  LET m == toRenderer[i] IN
  /\ toRenderer' = SubSeq(toRenderer, 1, i - 1) \o SubSeq(toRenderer, i + 1, Len(toRenderer))
  /\ IF m.type = "push" THEN Receive(m) ELSE Settle(m)
  /\ UNCHANGED <<seq, requests, loads>>

Next ==
  \/ Publish
  \/ \E l \in requests : Transcript(l)
  \/ Load
  \/ Unload
  \/ \E i \in DOMAIN toRenderer : Deliverable(i) /\ Deliver(i)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

NoDuplicateApply ==
  byThread.status = "ready" =>
    \A i, j \in DOMAIN byThread.folded : i /= j => byThread.folded[i] /= byThread.folded[j]

\* Checks only that nothing is missing; NoDuplicateApply covers duplicates.
NoGapAtQuiescence ==
  (byThread.status = "ready" /\ toRenderer = <<>> /\ requests = {})
    => \A s \in 1..seq : \E i \in DOMAIN byThread.folded : byThread.folded[i] = s

StaleSnapshotNeverApplied ==
  byThread.status = "ready" => byThread.snapshotFrom = byThread.load
=============================================================================
