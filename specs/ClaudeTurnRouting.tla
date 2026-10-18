---------------------------- MODULE ClaudeTurnRouting ----------------------------
(* How hinacode routes Claude Code CLI output to the turns of one thread: the CLI, the provider session and
   its pump in src/main/agents/claude/index.ts, and AgentRunner's turn (src/main/services/AgentRunner.ts). *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  CliBatchesSteers,  \* may the CLI answer several queued steers, even of different turns, under one result?
  CliReportsState,   \* does the CLI send session_state_changed? index.ts asks for it; CLIs that predate it don't
  MaxSends, MaxSteers, MaxInterrupts, MaxAbandons, MaxContent, MaxBackground

ASSUME CliBatchesSteers \in BOOLEAN /\ CliReportsState \in BOOLEAN

Turns == 1..MaxSends
None == 0
\* A prompt's uuid. index.ts mints a random one per prompt; the model numbers them in the order they are sent.
Prompts == 1..(MaxSends + MaxSteers)

VARIABLES
  \* CLI
  stdin,             \* prompts and query.interrupt() control requests, in the order hinacode sent them
  backlog,           \* prompts the CLI has read and not started
  cliPhase, answering, contentSent, stdout,
  bgOwner,           \* prompts answered by the response that launched the background sub-agent still running
  followup,          \* prompts answered by the response that launched a finished sub-agent Claude has not replied to
  replying,          \* while Claude replies to a finished sub-agent, the prompts answered by the response that launched it
  idleSent,          \* the CLI announced idle and has not started anything since
  bgLeft,
  \* provider session (index.ts:75-108)
  turn, turnPrompts, unanswered, heldEnd,
  \* AgentRunner
  busy,              \* busyThreads.has(thread)
  activeTurn,        \* activeTurns.get(thread)
  status,            \* thread status shown in the UI
  consumer,          \* the turn's Stream.runForEach(handle)
  queue,             \* queue[k]: events pump emitted into turn k's queue, not yet handled
  \* ghost
  sent, promptsSent, turnOf, steersLeft, interruptsLeft, abandonsLeft,
  delivered,         \* an event answering the prompts of turns `from`, or replying to a sub-agent of turns `bg`,
                     \* was offered to turn `to`
  droppedContent,    \* the turns answered by each content message pump discarded
  abandoned, finished, rejectedSteerWhileRunning

bgVars == <<bgOwner, followup, replying, idleSent, bgLeft>>
cliVars == <<stdin, backlog, cliPhase, answering, contentSent, stdout, bgVars>>
sessionVars == <<turn, turnPrompts, unanswered, heldEnd>>
runnerVars == <<busy, activeTurn, status, consumer, queue>>
ghostVars == <<sent, promptsSent, turnOf, steersLeft, interruptsLeft, abandonsLeft, delivered, droppedContent,
               abandoned, finished, rejectedSteerWhileRunning>>
vars == <<cliVars, sessionVars, runnerVars, ghostVars>>

StdinEntry == [kind : {"prompt", "interrupt"}, prompt : Prompts \cup {None}, steer : BOOLEAN]

TurnsOf(ps) == {turnOf[p] : p \in ps}

TypeOK ==
  /\ stdin \in Seq(StdinEntry) /\ backlog \in Seq(StdinEntry)
  /\ cliPhase \in {"idle", "streaming", "generated"}
  /\ answering \subseteq Prompts /\ contentSent \in 0..MaxContent
  /\ stdout \in Seq([type : {"content", "result", "idle"}, from : SUBSET Prompts, bg : SUBSET Prompts])
  /\ bgOwner \subseteq Prompts /\ followup \subseteq Prompts /\ replying \subseteq Prompts
  /\ idleSent \in BOOLEAN /\ bgLeft \in 0..MaxBackground
  /\ turn \in Turns \cup {None} /\ turnPrompts \subseteq Prompts /\ unanswered \subseteq Prompts
  /\ heldEnd \in BOOLEAN
  /\ busy \in BOOLEAN /\ activeTurn \in Turns \cup {None} /\ status \in {"idle", "running"}
  /\ consumer \in {"none", "starting", "reading", "ended"}
  /\ queue \in [Turns -> Seq([type : {"content", "result", "failed"}, from : SUBSET Turns])]
  /\ sent \in 0..MaxSends /\ promptsSent \in 0..(MaxSends + MaxSteers)
  /\ turnOf \in [Prompts -> Turns \cup {None}] /\ steersLeft \in 0..MaxSteers
  /\ interruptsLeft \in 0..MaxInterrupts /\ abandonsLeft \in 0..MaxAbandons
  /\ delivered \subseteq [to : Turns, from : SUBSET Turns, bg : SUBSET Turns]
  /\ droppedContent \subseteq SUBSET Turns
  /\ abandoned \subseteq Turns /\ finished \subseteq Turns
  /\ rejectedSteerWhileRunning \in BOOLEAN

Init ==
  /\ stdin = <<>> /\ backlog = <<>> /\ cliPhase = "idle" /\ answering = {} /\ contentSent = 0
  /\ stdout = <<>>
  /\ bgOwner = {} /\ followup = {} /\ replying = {} /\ idleSent = TRUE /\ bgLeft = MaxBackground
  /\ turn = None /\ turnPrompts = {} /\ unanswered = {} /\ heldEnd = FALSE
  /\ busy = FALSE /\ activeTurn = None /\ status = "idle" /\ consumer = "none"
  /\ queue = [k \in Turns |-> <<>>]
  /\ sent = 0 /\ promptsSent = 0 /\ turnOf = [p \in Prompts |-> None]
  /\ steersLeft = MaxSteers /\ interruptsLeft = MaxInterrupts /\ abandonsLeft = MaxAbandons
  /\ delivered = {} /\ droppedContent = {} /\ abandoned = {} /\ finished = {}
  /\ rejectedSteerWhileRunning = FALSE

-----------------------------------------------------------------------------

Prompt(p, steer) == [kind |-> "prompt", prompt |-> p, steer |-> steer]
InterruptRequest == [kind |-> "interrupt", prompt |-> None, steer |-> FALSE]

\* Mints the next prompt's uuid for turn k and records it as sent but unanswered.
SendPrompt(k, steer) ==
  LET p == promptsSent + 1 IN
  /\ promptsSent' = p
  /\ turnOf' = [turnOf EXCEPT ![p] = k]
  /\ turnPrompts' = turnPrompts \cup {p}
  /\ unanswered' = unanswered \cup {p}
  /\ stdin' = Append(stdin, Prompt(p, steer))

\* AgentRunner.ts:518-541 sendWhen + 449-516 startTurn (the forked turn.run starts in RunTurn)
Send ==
  /\ ~busy /\ sent < MaxSends
  /\ sent' = sent + 1
  /\ busy' = TRUE /\ activeTurn' = sent + 1 /\ status' = "running" /\ consumer' = "starting"
  /\ UNCHANGED <<cliVars, sessionVars, queue, promptsSent, turnOf, steersLeft, interruptsLeft, abandonsLeft,
                 delivered, droppedContent, abandoned, finished, rejectedSteerWhileRunning>>

\* index.ts:586-644 runTurn, everything after acquireSession; AgentRunner.ts:407-431 turns its error into turn_failed
RunTurn ==
  /\ consumer = "starting"
  /\ consumer' = "reading"
  /\ IF turn # None
     THEN /\ queue' = [queue EXCEPT ![activeTurn] = <<[type |-> "failed", from |-> {activeTurn}]>>]
          /\ UNCHANGED <<stdin, sessionVars, promptsSent, turnOf>>
     ELSE /\ turn' = activeTurn /\ heldEnd' = FALSE
          /\ SendPrompt(activeTurn, FALSE)
          /\ turnPrompts' = {promptsSent + 1}
          /\ UNCHANGED queue
  /\ UNCHANGED <<backlog, cliPhase, answering, contentSent, stdout, bgVars, busy, activeTurn, status, sent, steersLeft,
                 interruptsLeft, abandonsLeft, delivered, droppedContent, abandoned, finished,
                 rejectedSteerWhileRunning>>

\* AgentRunner.ts:543-546 routes to makeTurn's steer (358-378), which calls index.ts:646-656 steer.
\* With no activeTurns entry it falls back to send, which the Send action already covers.
Steer ==
  /\ activeTurn # None /\ steersLeft > 0
  /\ steersLeft' = steersLeft - 1
  /\ IF turn = None
     THEN /\ rejectedSteerWhileRunning' = (rejectedSteerWhileRunning \/ status = "running")
          /\ UNCHANGED <<stdin, sessionVars, promptsSent, turnOf>>
     ELSE /\ SendPrompt(turn, TRUE)
          /\ UNCHANGED <<turn, heldEnd, rejectedSteerWhileRunning>>
  /\ UNCHANGED <<backlog, cliPhase, answering, contentSent, stdout, bgVars, runnerVars, sent, interruptsLeft,
                 abandonsLeft, delivered, droppedContent, abandoned, finished>>

\* AgentRunner.ts:642-648 -> makeTurn's interrupt -> index.ts:570-574 interruptQuery. `interrupted` only
\* relabels the turn's failure, so it is not modeled.
Interrupt ==
  /\ activeTurn # None /\ interruptsLeft > 0
  /\ interruptsLeft' = interruptsLeft - 1
  /\ stdin' = Append(stdin, InterruptRequest)
  /\ UNCHANGED <<backlog, cliPhase, answering, contentSent, stdout, bgVars, sessionVars, runnerVars, sent, promptsSent,
                 turnOf, steersLeft, abandonsLeft, delivered, droppedContent, abandoned, finished,
                 rejectedSteerWhileRunning>>

\* index.ts:623-632 finalizer. The consumer stops early when `handle` fails or the FiberMap is torn down;
\* `finish` still runs through Effect.ensuring (AgentRunner.ts:428).
Abandon ==
  /\ consumer = "reading" /\ abandonsLeft > 0
  /\ abandonsLeft' = abandonsLeft - 1
  /\ consumer' = "ended" /\ abandoned' = abandoned \cup {activeTurn}
  /\ IF turn = activeTurn
     THEN /\ turn' = None /\ turnPrompts' = {} /\ stdin' = Append(stdin, InterruptRequest)
     ELSE UNCHANGED <<turn, turnPrompts, stdin>>
  /\ UNCHANGED <<backlog, cliPhase, answering, contentSent, stdout, bgVars, unanswered, heldEnd, busy, activeTurn, status,
                 queue, sent, promptsSent, turnOf, steersLeft, interruptsLeft, delivered, droppedContent,
                 finished, rejectedSteerWhileRunning>>

\* AgentRunner.ts:331-356 handle, one exclusive section per event; a terminal event ends the stream
Handle ==
  /\ consumer = "reading" /\ queue[activeTurn] # <<>>
  /\ queue' = [queue EXCEPT ![activeTurn] = Tail(@)]
  /\ IF Head(queue[activeTurn]).type \in {"result", "failed"}
     THEN status' = "idle" /\ consumer' = "ended"
     ELSE UNCHANGED <<status, consumer>>
  /\ UNCHANGED <<cliVars, sessionVars, busy, activeTurn, ghostVars>>

\* AgentRunner.ts:380-405 finish, the only place activeTurns is cleared
Finish ==
  /\ consumer = "ended"
  /\ finished' = finished \cup {activeTurn}
  /\ busy' = FALSE /\ activeTurn' = None /\ status' = "idle" /\ consumer' = "none"
  /\ UNCHANGED <<cliVars, sessionVars, queue, sent, promptsSent, turnOf, steersLeft, interruptsLeft,
                 abandonsLeft, delivered, droppedContent, abandoned, rejectedSteerWhileRunning>>

-----------------------------------------------------------------------------

\* The turns an output belongs to: those whose prompts it answers, or that launched the sub-agent it replies to.
Owners(m) == TurnsOf(m.from \cup m.bg)

Discard(m) ==
  /\ droppedContent' = IF m.type = "content" THEN droppedContent \cup {Owners(m)} ELSE droppedContent
  /\ UNCHANGED <<turn, turnPrompts, heldEnd, queue, delivered>>

Swallow == UNCHANGED <<turn, turnPrompts, heldEnd, queue, delivered, droppedContent>>

\* index.ts:311-322 emit; mapMessage.ts makes every result terminal. index.ts:466-469 holds that end until idle
\* when the CLI reports its state.
Emit(m) ==
  /\ delivered' = delivered \cup {[to |-> turn, from |-> TurnsOf(m.from), bg |-> TurnsOf(m.bg)]}
  /\ IF m.type = "result" /\ CliReportsState
     THEN /\ heldEnd' = TRUE
          /\ UNCHANGED <<turn, turnPrompts, queue>>
     ELSE /\ queue' = [queue EXCEPT ![turn] = Append(@, [type |-> m.type, from |-> Owners(m)])]
          /\ IF m.type = "result" THEN turn' = None /\ turnPrompts' = {} ELSE UNCHANGED <<turn, turnPrompts>>
          /\ UNCHANGED heldEnd
  /\ UNCHANGED droppedContent

\* index.ts:425-430 emits the held end once the CLI is idle and every prompt of the turn is answered
EndHeld ==
  /\ queue' = [queue EXCEPT ![turn] = Append(@, [type |-> "result", from |-> {turn}])]
  /\ turn' = None /\ turnPrompts' = {} /\ heldEnd' = FALSE
  /\ UNCHANGED <<delivered, droppedContent>>

\* index.ts:423-470 route, one Effect.sync per SDK message. A message's `from` stands for the uuids the CLI
\* stamped on its response's first message, which route keeps in session.answering. A reply to a finished
\* sub-agent answers no prompt, so it goes to whichever turn is running.
Pump ==
  /\ stdout # <<>>
  /\ stdout' = Tail(stdout)
  /\ LET m == Head(stdout)
         left == IF m.type = "result" THEN unanswered \ m.from ELSE unanswered
     IN /\ unanswered' = left
        /\ CASE m.type = "idle" ->
                IF heldEnd /\ turn # None /\ turnPrompts \cap unanswered = {} THEN EndHeld ELSE Swallow
             [] turn = None \/ (m.from # {} /\ m.from \cap turnPrompts = {}) -> Discard(m)
             [] m.type = "result" /\ turnPrompts \cap left # {} -> Swallow
             [] OTHER -> Emit(m)
  /\ UNCHANGED <<stdin, backlog, cliPhase, answering, contentSent, bgVars, busy, activeTurn, status, consumer, sent,
                 promptsSent, turnOf, steersLeft, interruptsLeft, abandonsLeft, abandoned, finished,
                 rejectedSteerWhileRunning>>

-----------------------------------------------------------------------------
(* The Claude Code CLI, as observed with 2.1.299 by specs/probes/claude-cli.mjs:
   - it answers a prompt, or a batch of steers, with zero or more content messages and exactly one result;
   - it queues by priority: a steer (`now`) starts before any queued prompt (`next`), even one sent earlier
     (seen with 2.1.294 in a one-off probe, like the next two cross-turn bullets);
   - a response's first message and its result carry the uuids of the prompts it answers
     (user_message_uuid, user_message_uuids);
   - a steer it reads while the response streams ends that response with an aborted result;
   - a steer it reads after generation, e.g. during a Stop hook, gets no abort: the old response ends with
     a completed result and the steer is answered under its own result;
   - queued steers get one combined answer, even across a queued prompt and across turns (CliBatchesSteers);
   - it reads input while prompts wait in its queue, so later steers can join that batch;
   - query.interrupt() aborts only the in-flight response and keeps the prompts already queued.
   And by specs/probes/claude-background.mjs with 2.1.302:
   - a response can launch a background sub-agent and end with its result while the sub-agent runs;
   - when the sub-agent finishes, Claude replies to its report with a response that answers no prompt;
   - query.interrupt() kills background sub-agents, since index.ts declares no perTaskStopAffordance;
   - with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS it announces idle once nothing is queued or running. *)

Out(type) == stdout' = Append(stdout, [type |-> type, from |-> answering, bg |-> replying])

unchangedOutsideCli == <<sessionVars, runnerVars, ghostVars>>

\* Starts the oldest steer, batched with the steers queued after it, or else the oldest prompt.
CliStart ==
  /\ cliPhase = "idle" /\ backlog # <<>>
  /\ LET steers == {i \in 1..Len(backlog) : backlog[i].steer} IN
     \E taken \in SUBSET (1..Len(backlog)) :
       /\ IF steers = {}
          THEN taken = {1}
          ELSE /\ taken # {} /\ taken \subseteq steers
               /\ \A i \in taken, j \in steers : j < i => j \in taken
               /\ CliBatchesSteers \/ Cardinality(taken) = 1
       /\ answering' = {backlog[i].prompt : i \in taken}
       /\ backlog' = SelectSeq(backlog, LAMBDA e : e.prompt \notin answering')
  /\ cliPhase' = "streaming" /\ contentSent' = 0 /\ replying' = {} /\ idleSent' = FALSE
  /\ UNCHANGED <<stdin, stdout, bgOwner, followup, bgLeft, unchangedOutsideCli>>

\* Replies to a finished sub-agent's report. Whether a queued prompt goes first is not known, so either may.
CliStartFollowup ==
  /\ cliPhase = "idle" /\ followup # {}
  /\ answering' = {} /\ replying' = followup /\ followup' = {}
  /\ cliPhase' = "streaming" /\ contentSent' = 0 /\ idleSent' = FALSE
  /\ UNCHANGED <<stdin, backlog, stdout, bgOwner, bgLeft, unchangedOutsideCli>>

CliLaunch ==
  /\ cliPhase = "streaming" /\ answering # {} /\ bgOwner = {} /\ followup = {} /\ bgLeft > 0
  /\ bgOwner' = answering /\ bgLeft' = bgLeft - 1
  /\ UNCHANGED <<stdin, backlog, cliPhase, answering, contentSent, stdout, followup, replying, idleSent,
                 unchangedOutsideCli>>

CliSubagentDone ==
  /\ bgOwner # {}
  /\ followup' = bgOwner /\ bgOwner' = {}
  /\ UNCHANGED <<stdin, backlog, cliPhase, answering, contentSent, stdout, replying, idleSent, bgLeft,
                 unchangedOutsideCli>>

CliIdle ==
  /\ CliReportsState /\ ~idleSent
  /\ cliPhase = "idle" /\ backlog = <<>> /\ bgOwner = {} /\ followup = {}
  /\ idleSent' = TRUE
  /\ stdout' = Append(stdout, [type |-> "idle", from |-> {}, bg |-> {}])
  /\ UNCHANGED <<stdin, backlog, cliPhase, answering, contentSent, bgOwner, followup, replying, bgLeft,
                 unchangedOutsideCli>>

CliContent ==
  /\ cliPhase = "streaming" /\ contentSent < MaxContent
  /\ contentSent' = contentSent + 1 /\ Out("content")
  /\ UNCHANGED <<stdin, backlog, cliPhase, answering, bgVars, unchangedOutsideCli>>

CliFinishGenerating ==
  /\ cliPhase = "streaming" /\ cliPhase' = "generated"
  /\ UNCHANGED <<stdin, backlog, answering, contentSent, stdout, bgVars, unchangedOutsideCli>>

CliResult ==
  /\ cliPhase = "generated" /\ cliPhase' = "idle" /\ Out("result")
  /\ UNCHANGED <<stdin, backlog, answering, contentSent, bgVars, unchangedOutsideCli>>

CliSteerAbort ==
  /\ cliPhase = "streaming" /\ \E i \in 1..Len(backlog) : backlog[i].steer
  /\ cliPhase' = "idle" /\ Out("result")
  /\ UNCHANGED <<stdin, backlog, answering, contentSent, bgVars, unchangedOutsideCli>>

CliRead ==
  /\ stdin # <<>>
  /\ stdin' = Tail(stdin)
  /\ IF Head(stdin).kind = "prompt"
     THEN /\ backlog' = Append(backlog, Head(stdin))
          /\ UNCHANGED <<cliPhase, stdout, bgOwner>>
     ELSE /\ IF cliPhase = "idle" THEN UNCHANGED stdout ELSE Out("result")
          /\ cliPhase' = "idle" /\ bgOwner' = {}
          /\ UNCHANGED backlog
  /\ UNCHANGED <<answering, contentSent, followup, replying, idleSent, bgLeft, unchangedOutsideCli>>

-----------------------------------------------------------------------------

Next ==
  \/ Send \/ RunTurn \/ Steer \/ Interrupt \/ Abandon \/ Handle \/ Finish \/ Pump
  \/ CliStart \/ CliContent \/ CliFinishGenerating \/ CliResult \/ CliSteerAbort \/ CliRead
  \/ CliStartFollowup \/ CliLaunch \/ CliSubagentDone \/ CliIdle

\* Send, Steer and Interrupt are user actions and Abandon comes from a `handle` failure or FiberMap
\* teardown, so none of them is forced.
Fairness ==
  /\ WF_vars(RunTurn) /\ WF_vars(Handle) /\ WF_vars(Finish) /\ WF_vars(Pump)
  /\ WF_vars(CliStart) /\ WF_vars(CliFinishGenerating) /\ WF_vars(CliResult) /\ WF_vars(CliRead)
  /\ WF_vars(CliStartFollowup) /\ WF_vars(CliSubagentDone) /\ WF_vars(CliIdle)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------

\* Output reaches only a turn it answers. It may also answer a steer of an abandoned turn, which the CLI
\* batched with this turn's steer; that steer has no consumer left to show it. A reply to a sub-agent answers
\* no prompt and reaches the turn that launched the sub-agent, or the next one once that turn is abandoned.
NoCrossTurnLeak ==
  \A d \in delivered :
    IF d.from # {}
    THEN d.to \in d.from /\ d.from \ {d.to} \subseteq abandoned
    ELSE d.bg \ {d.to} \subseteq abandoned

NoSilentDrop == \A from \in droppedContent : from \subseteq abandoned

TurnsEnd ==
  /\ \A k \in Turns : (k \in 1..sent) ~> (k \in finished)
  /\ <>[](status = "idle" /\ activeTurn = None)

SteerNeverRejectedWhileRunning == ~rejectedSteerWhileRunning

=============================================================================
