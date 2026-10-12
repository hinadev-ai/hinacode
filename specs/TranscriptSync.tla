---------------------------- MODULE TranscriptSync ----------------------------
(* How the renderer keeps one thread's transcript in sync with main: a `threads.transcript` snapshot plus
   `seq`-numbered pushes (docs/arch.md "Renderer sync: snapshot plus pushes"). *)
EXTENDS Naturals, Sequences

CONSTANTS
  MaxEvents,  \* events main publishes for the thread
  MaxLoads,   \* times the user opens the thread
  IpcOrdered, \* TRUE: pushes and rpc replies share one FIFO to the renderer
  Design      \* "current" | "fixed": settle checks a load token and receive drops seqs already folded

ASSUME Design \in {"current", "fixed"}

\* An event is identified by its seq, so main's transcript is always 1..seq.
VARIABLES
  seq,        \* AgentRunner.ts:103
  requests,   \* load ids whose threads.transcript rpc main has not run yet
  toRenderer, \* oldest first
  byThread,   \* messages.ts:21, the entry for the modeled thread
  loads       \* how many times `load` has started; also the latest load id

vars == <<seq, requests, toRenderer, byThread, loads>>

Push(s)     == [type |-> "push", seq |-> s]
Reply(l, s) == [type |-> "reply", load |-> l, seq |-> s]

\* Status "missing" stands for an absent key. `load` is the load that set "loading": a ghost under
\* "current", the token under "fixed". `snapshotFrom` is a ghost; `lastSeq` exists only under "fixed".
Missing == [status |-> "missing", pending |-> <<>>, folded |-> <<>>,
            load |-> 0, snapshotFrom |-> 0, lastSeq |-> 0]

Max(a, b) == IF a > b THEN a ELSE b
Range(n)  == [k \in 1..n |-> k]

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
(* Main runs each step under the per-thread `exclusive` lock (AgentRunner.ts:118-124), so publishing and
   snapshotting are atomic with respect to each other. `webContents.send` (ipc.ts:173) enqueues synchronously. *)

\* AgentRunner.ts:126 publishTranscript
Publish ==
  /\ seq < MaxEvents
  /\ seq' = seq + 1
  /\ toRenderer' = Append(toRenderer, Push(seq + 1))
  /\ UNCHANGED <<requests, byThread, loads>>

\* AgentRunner.ts:273-287, reply sent through ipcMain.handle, ipc.ts:158-162
Transcript(l) ==
  /\ requests' = requests \ {l}
  /\ toRenderer' = Append(toRenderer, Reply(l, seq))
  /\ UNCHANGED <<seq, byThread, loads>>

-----------------------------------------------------------------------------

\* ThreadView.tsx:51 -> messages.ts:44-52 up to the await. Errors are not modeled, so `load` only runs on "missing".
Load ==
  /\ loads < MaxLoads
  /\ byThread.status = "missing"
  /\ loads' = loads + 1
  /\ byThread' = [Missing EXCEPT !.status = "loading", !.load = loads + 1]
  /\ requests' = requests \cup {loads + 1}
  /\ UNCHANGED <<seq, toRenderer>>

\* ThreadView.tsx:54-57 -> messages.ts:61. The busy check reads a status that itself arrives by push, so
\* whether it lets unload through is left nondeterministic.
Unload ==
  /\ byThread.status /= "missing"
  /\ byThread' = Missing
  /\ UNCHANGED <<seq, requests, toRenderer, loads>>

\* messages.ts:53-55 after the await, through `settle` at 49-50
Settle(r) ==
  IF /\ byThread.status = "loading"
     /\ (Design = "fixed" => byThread.load = r.load)
  THEN LET replay == SelectSeq(byThread.pending, LAMBDA s : s > r.seq)
       IN byThread' = [byThread EXCEPT
                         !.status = "ready",
                         !.folded = Range(r.seq) \o replay,
                         !.snapshotFrom = r.load,
                         !.lastSeq = IF replay = <<>> THEN r.seq ELSE replay[Len(replay)]]
  ELSE UNCHANGED byThread

\* messages.ts:67-77. Folding is not idempotent (foldEvent.ts:11 text_delta appends).
Receive(p) ==
  CASE byThread.status = "loading" ->
         byThread' = [byThread EXCEPT !.pending = Append(@, p.seq)]
    [] byThread.status = "ready" /\ Design = "fixed" /\ p.seq <= byThread.lastSeq ->
         UNCHANGED byThread
    [] byThread.status = "ready" ->
         byThread' = [byThread EXCEPT !.folded = Append(@, p.seq), !.lastSeq = Max(@, p.seq)]
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
