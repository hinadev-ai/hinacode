---------------------------- MODULE ClaudeTurnRouting ----------------------------
(* How kkcode routes Claude Code CLI output to the turns of one thread: the CLI, the provider session and
   its pump in src/main/agents/claude/index.ts, and AgentRunner's turn (src/main/services/AgentRunner.ts). *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  CliBatchesSteers,  \* may the CLI answer several queued steers under one result?
  MaxSends, MaxSteers, MaxInterrupts, MaxAbandons, MaxContent

ASSUME CliBatchesSteers \in BOOLEAN

Turns == 1..MaxSends
None == 0

VARIABLES
  \* CLI
  stdin,             \* prompts and query.interrupt() control requests, in the order kkcode sent them
  backlog,           \* prompts the CLI has read and not started
  cliPhase, answeringTurns, contentSent, stdout,
  \* provider session (index.ts:25-39)
  turn, interrupted, pendingSteers, abandonedTurns,
  \* AgentRunner
  busy,              \* busyThreads.has(thread)
  activeTurn,        \* activeTurns.get(thread)
  status,            \* thread status shown in the UI
  consumer,          \* the turn's Stream.runForEach(handle)
  queue,             \* queue[k]: events pump emitted into turn k's queue, not yet handled
  \* ghost
  sent, steersLeft, interruptsLeft, abandonsLeft,
  delivered,         \* an event answering the prompts of turns `from` was offered to turn `to`
  droppedContent,    \* the `from` of each content message pump discarded
  abandoned, finished, rejectedSteerWhileRunning

cliVars == <<stdin, backlog, cliPhase, answeringTurns, contentSent, stdout>>
sessionVars == <<turn, interrupted, pendingSteers, abandonedTurns>>
runnerVars == <<busy, activeTurn, status, consumer, queue>>
ghostVars == <<sent, steersLeft, interruptsLeft, abandonsLeft, delivered, droppedContent, abandoned, finished,
               rejectedSteerWhileRunning>>
vars == <<cliVars, sessionVars, runnerVars, ghostVars>>

StdinEntry == [kind : {"prompt", "interrupt"}, turn : Turns \cup {None}, steer : BOOLEAN]

TypeOK ==
  /\ stdin \in Seq(StdinEntry) /\ backlog \in Seq(StdinEntry)
  /\ cliPhase \in {"idle", "streaming", "generated"}
  /\ answeringTurns \subseteq Turns /\ contentSent \in 0..MaxContent
  /\ stdout \in Seq([type : {"content", "result"}, steerAbort : BOOLEAN, from : SUBSET Turns])
  /\ turn \in Turns \cup {None} /\ interrupted \in BOOLEAN
  /\ pendingSteers \in Nat /\ abandonedTurns \in Nat
  /\ busy \in BOOLEAN /\ activeTurn \in Turns \cup {None} /\ status \in {"idle", "running"}
  /\ consumer \in {"none", "starting", "reading", "ended"}
  /\ queue \in [Turns -> Seq([type : {"content", "result", "failed"}, from : SUBSET Turns])]
  /\ sent \in 0..MaxSends /\ steersLeft \in 0..MaxSteers
  /\ interruptsLeft \in 0..MaxInterrupts /\ abandonsLeft \in 0..MaxAbandons
  /\ delivered \subseteq [to : Turns, from : SUBSET Turns]
  /\ droppedContent \subseteq SUBSET Turns
  /\ abandoned \subseteq Turns /\ finished \subseteq Turns
  /\ rejectedSteerWhileRunning \in BOOLEAN

Init ==
  /\ stdin = <<>> /\ backlog = <<>> /\ cliPhase = "idle" /\ answeringTurns = {} /\ contentSent = 0
  /\ stdout = <<>>
  /\ turn = None /\ interrupted = FALSE /\ pendingSteers = 0 /\ abandonedTurns = 0
  /\ busy = FALSE /\ activeTurn = None /\ status = "idle" /\ consumer = "none"
  /\ queue = [k \in Turns |-> <<>>]
  /\ sent = 0 /\ steersLeft = MaxSteers /\ interruptsLeft = MaxInterrupts /\ abandonsLeft = MaxAbandons
  /\ delivered = {} /\ droppedContent = {} /\ abandoned = {} /\ finished = {}
  /\ rejectedSteerWhileRunning = FALSE

-----------------------------------------------------------------------------

Prompt(k, steer) == [kind |-> "prompt", turn |-> k, steer |-> steer]
InterruptRequest == [kind |-> "interrupt", turn |-> None, steer |-> FALSE]

\* AgentRunner.ts:248-258 send + 227-246 startTurn (the forked turn.run starts in RunTurn)
Send ==
  /\ ~busy /\ sent < MaxSends
  /\ sent' = sent + 1
  /\ busy' = TRUE /\ activeTurn' = sent + 1 /\ status' = "running" /\ consumer' = "starting"
  /\ UNCHANGED <<cliVars, sessionVars, queue, steersLeft, interruptsLeft, abandonsLeft, delivered,
                 droppedContent, abandoned, finished, rejectedSteerWhileRunning>>

\* index.ts:262-294 runTurn, everything after acquireSession; AgentRunner.ts:219 turns its error into turn_failed
RunTurn ==
  /\ consumer = "starting"
  /\ consumer' = "reading"
  /\ IF turn # None
     THEN /\ queue' = [queue EXCEPT ![activeTurn] = <<[type |-> "failed", from |-> {activeTurn}]>>]
          /\ UNCHANGED <<stdin, sessionVars>>
     ELSE /\ turn' = activeTurn /\ interrupted' = FALSE /\ pendingSteers' = 0
          /\ stdin' = Append(stdin, Prompt(activeTurn, FALSE))
          /\ UNCHANGED <<queue, abandonedTurns>>
  /\ UNCHANGED <<backlog, cliPhase, answeringTurns, contentSent, stdout, busy, activeTurn, status, ghostVars>>

\* AgentRunner.ts:262-263 routes to makeTurn's steer (172-186), which calls index.ts:296-306 steer.
\* With no activeTurns entry it falls back to send, which the Send action already covers.
Steer ==
  /\ activeTurn # None /\ steersLeft > 0
  /\ steersLeft' = steersLeft - 1
  /\ IF turn = None
     THEN /\ rejectedSteerWhileRunning' = (rejectedSteerWhileRunning \/ status = "running")
          /\ UNCHANGED <<stdin, pendingSteers>>
     ELSE /\ pendingSteers' = pendingSteers + 1
          /\ stdin' = Append(stdin, Prompt(activeTurn, TRUE))
          /\ UNCHANGED rejectedSteerWhileRunning
  /\ UNCHANGED <<backlog, cliPhase, answeringTurns, contentSent, stdout, turn, interrupted, abandonedTurns,
                 runnerVars, sent, interruptsLeft, abandonsLeft, delivered, droppedContent, abandoned, finished>>

\* AgentRunner.ts:264-265 -> index.ts:336-339 -> interruptQuery index.ts:256-260
Interrupt ==
  /\ activeTurn # None /\ interruptsLeft > 0
  /\ interruptsLeft' = interruptsLeft - 1
  /\ interrupted' = TRUE /\ stdin' = Append(stdin, InterruptRequest)
  /\ UNCHANGED <<backlog, cliPhase, answeringTurns, contentSent, stdout, turn, pendingSteers, abandonedTurns,
                 runnerVars, sent, steersLeft, abandonsLeft, delivered, droppedContent, abandoned, finished,
                 rejectedSteerWhileRunning>>

\* index.ts:283-290 finalizer. The consumer stops early when `handle` fails (AgentRunner.ts:220) or the
\* FiberMap is torn down; `finish` still runs through Effect.ensuring (AgentRunner.ts:221).
Abandon ==
  /\ consumer = "reading" /\ abandonsLeft > 0
  /\ abandonsLeft' = abandonsLeft - 1
  /\ consumer' = "ended" /\ abandoned' = abandoned \cup {activeTurn}
  /\ IF turn = activeTurn
     THEN /\ turn' = None /\ interrupted' = TRUE /\ stdin' = Append(stdin, InterruptRequest)
          /\ abandonedTurns' = abandonedTurns + 1
     ELSE UNCHANGED <<turn, interrupted, stdin, abandonedTurns>>
  /\ UNCHANGED <<backlog, cliPhase, answeringTurns, contentSent, stdout, pendingSteers, busy, activeTurn, status,
                 queue, sent, steersLeft, interruptsLeft, delivered, droppedContent, finished,
                 rejectedSteerWhileRunning>>

\* AgentRunner.ts:154-170 handle, one exclusive section per event; a terminal event ends the stream
Handle ==
  /\ consumer = "reading" /\ queue[activeTurn] # <<>>
  /\ queue' = [queue EXCEPT ![activeTurn] = Tail(@)]
  /\ IF Head(queue[activeTurn]).type \in {"result", "failed"}
     THEN status' = "idle" /\ consumer' = "ended"
     ELSE UNCHANGED <<status, consumer>>
  /\ UNCHANGED <<cliVars, sessionVars, busy, activeTurn, ghostVars>>

\* AgentRunner.ts:188-203 finish, the only place activeTurns is cleared
Finish ==
  /\ consumer = "ended"
  /\ finished' = finished \cup {activeTurn}
  /\ busy' = FALSE /\ activeTurn' = None /\ status' = "idle" /\ consumer' = "none"
  /\ UNCHANGED <<cliVars, sessionVars, queue, sent, steersLeft, interruptsLeft, abandonsLeft, delivered,
                 droppedContent, abandoned, rejectedSteerWhileRunning>>

-----------------------------------------------------------------------------

Discard(m) ==
  /\ droppedContent' = IF m.type = "content" THEN droppedContent \cup {m.from} ELSE droppedContent
  /\ UNCHANGED <<turn, queue, delivered>>

\* index.ts:130-138 emit; mapMessage.ts:63-64 makes every result terminal
Emit(m) ==
  IF turn = None THEN Discard(m)
  ELSE /\ queue' = [queue EXCEPT ![turn] = Append(@, [type |-> m.type, from |-> m.from])]
       /\ delivered' = delivered \cup {[to |-> turn, from |-> m.from]}
       /\ turn' = IF m.type = "result" THEN None ELSE turn
       /\ UNCHANGED droppedContent

\* index.ts:157-174 pump, one Effect.sync per SDK message
Pump ==
  /\ stdout # <<>>
  /\ stdout' = Tail(stdout)
  /\ LET m == Head(stdout) IN
     CASE abandonedTurns > 0 ->                                                         \* index.ts:160-163
            /\ abandonedTurns' = IF m.type = "result" THEN abandonedTurns - 1 ELSE abandonedTurns
            /\ UNCHANGED pendingSteers /\ Discard(m)
       [] pendingSteers > 0 /\ ~interrupted /\ m.type = "result" /\ m.steerAbort ->     \* index.ts:164-167
            /\ pendingSteers' = pendingSteers - 1
            /\ UNCHANGED abandonedTurns /\ Discard(m)
       [] OTHER ->                                                                      \* index.ts:168-173
            /\ pendingSteers' = IF m.type = "result" THEN 0 ELSE pendingSteers
            /\ UNCHANGED abandonedTurns /\ Emit(m)
  /\ UNCHANGED <<stdin, backlog, cliPhase, answeringTurns, contentSent, interrupted, busy, activeTurn,
                 status, consumer, sent, steersLeft, interruptsLeft, abandonsLeft, abandoned, finished,
                 rejectedSteerWhileRunning>>

-----------------------------------------------------------------------------
(* The Claude Code CLI, as observed with 2.1.294 by specs/probes/claude-cli.mjs:
   - it reads prompts in order and answers each with zero or more content messages and exactly one result;
   - a steer it reads while the response streams ends that response with an aborted result;
   - a steer it reads after generation, e.g. during a Stop hook, gets no abort: the old response ends with
     a completed result and the steer is answered under its own result;
   - steers queued together get one combined answer (CliBatchesSteers);
   - query.interrupt() aborts only the in-flight response and keeps the prompts already queued. *)

Out(type, steerAbort) == stdout' = Append(stdout, [type |-> type, steerAbort |-> steerAbort, from |-> answeringTurns])

unchangedOutsideCli == <<sessionVars, runnerVars, ghostVars>>

CliStart ==
  /\ cliPhase = "idle" /\ backlog # <<>>
  /\ \E n \in 1..Len(backlog) :
       /\ n = 1 \/ (CliBatchesSteers /\ \A i \in 1..n : backlog[i].steer)
       /\ answeringTurns' = {backlog[i].turn : i \in 1..n}
       /\ backlog' = SubSeq(backlog, n + 1, Len(backlog))
  /\ cliPhase' = "streaming" /\ contentSent' = 0
  /\ UNCHANGED <<stdin, stdout, unchangedOutsideCli>>

CliContent ==
  /\ cliPhase = "streaming" /\ contentSent < MaxContent
  /\ contentSent' = contentSent + 1 /\ Out("content", FALSE)
  /\ UNCHANGED <<stdin, backlog, cliPhase, answeringTurns, unchangedOutsideCli>>

CliFinishGenerating ==
  /\ cliPhase = "streaming" /\ cliPhase' = "generated"
  /\ UNCHANGED <<stdin, backlog, answeringTurns, contentSent, stdout, unchangedOutsideCli>>

CliResult ==
  /\ cliPhase = "generated" /\ cliPhase' = "idle" /\ Out("result", FALSE)
  /\ UNCHANGED <<stdin, backlog, answeringTurns, contentSent, unchangedOutsideCli>>

CliSteerAbort ==
  /\ cliPhase = "streaming" /\ \E i \in 1..Len(backlog) : backlog[i].steer
  /\ cliPhase' = "idle" /\ Out("result", TRUE)
  /\ UNCHANGED <<stdin, backlog, answeringTurns, contentSent, unchangedOutsideCli>>

\* An idle CLI starts a queued prompt before it reads more input, so it never sits idle with a backlog.
CliRead ==
  /\ stdin # <<>> /\ ~(cliPhase = "idle" /\ backlog # <<>>)
  /\ stdin' = Tail(stdin)
  /\ IF Head(stdin).kind = "prompt"
     THEN /\ backlog' = Append(backlog, Head(stdin))
          /\ UNCHANGED <<cliPhase, stdout>>
     ELSE /\ IF cliPhase = "idle" THEN UNCHANGED stdout ELSE Out("result", TRUE)
          /\ cliPhase' = "idle"
          /\ UNCHANGED backlog
  /\ UNCHANGED <<answeringTurns, contentSent, unchangedOutsideCli>>

-----------------------------------------------------------------------------

Next ==
  \/ Send \/ RunTurn \/ Steer \/ Interrupt \/ Abandon \/ Handle \/ Finish \/ Pump
  \/ CliStart \/ CliContent \/ CliFinishGenerating \/ CliResult \/ CliSteerAbort \/ CliRead

\* Send, Steer and Interrupt are user actions and Abandon comes from a `handle` failure or FiberMap
\* teardown, so none of them is forced.
Fairness ==
  /\ WF_vars(RunTurn) /\ WF_vars(Handle) /\ WF_vars(Finish) /\ WF_vars(Pump)
  /\ WF_vars(CliStart) /\ WF_vars(CliFinishGenerating) /\ WF_vars(CliResult) /\ WF_vars(CliRead)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------

NoCrossTurnLeak == \A d \in delivered : d.from = {d.to}

NoSilentDrop == \A from \in droppedContent : from \subseteq abandoned

TurnsEnd ==
  /\ \A k \in Turns : (k \in 1..sent) ~> (k \in finished)
  /\ <>[](status = "idle" /\ activeTurn = None)

SteerNeverRejectedWhileRunning == ~rejectedSteerWhileRunning

=============================================================================
