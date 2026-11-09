---------------------------- MODULE ArtifactFeedback ----------------------------
(* Delivering a developer's artifact comment to the thread that owns the artifact.
   src/main/services/ArtifactFeedback.ts comment saves the comment in feedback.json, then deliver unarchives the
   thread, like the composer's send, and hands the prompt to AgentRunner.steer (src/main/services/AgentRunner.ts
   steerWhen). That steers a running turn or starts one, and deliver falls back to AgentRunner.queue when it fails
   with an AgentError. Anything else is only logged.
   Racing it: more comments, the turn ending, failing or being stopped, an approval that holds steers back, the
   developer archiving the thread, and the app quitting. Nothing persists a comment until it is in the thread's
   queue, so quitting between the save and the queue loses its delivery, which ArtifactFeedback.Crash.cfg pins.
   Resolving a comment does not touch its delivery, and comments cannot be edited or deleted, so neither is
   modeled. Mentions only change which thread receives it, so the model has one thread. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Comments,    \* the developer's comments, saved by concurrent artifacts.comment rpc calls
  Steers,      \* the thread's provider implements steer: Claude, magpie, Codex and Muse do, opencode (ACP) does not
  MaxTurns, MaxStops, MaxArchives, MaxAsks, MaxCrashes

None == "none"

VARIABLES
  status,     \* thread.status: idle, running (awaiting_approval included) or archived
  busy,       \* AgentRunner busyThreads: a send or a turn holds the thread
  active,     \* AgentRunner activeTurns: the turn object, 0 for none
  starting,   \* a turn admitted whose provider.runTurn has not started yet
  prov,       \* the turn the provider runs for this thread, which provider.steer reaches, 0 for none
  ended,      \* the provider's stream ended the active turn: no, completed or failed
  awaiting,   \* waitsOnUser: an approval or question is open
  stopped,    \* the stop Deferred of the current send or turn
  lock,       \* AgentRunner's per-thread Semaphore, held by finish across its two steps
  queue,      \* thread.queue in SQLite: records [c, steer], steer marking a message held back by an approval
  send,       \* the send in flight: [pc, c, origin], origin deliver, retry (from deliver's catch) or queued
  turns,      \* turns started so far
  pc,         \* each comment's rpc fiber
  captured,   \* the turn steerWhen found for a comment before it waited for the lock
  deliveries, \* how many times each comment reached the agent
  where,      \* <<turn the provider gave it to, turn AgentRunner recorded it in>> for each delivery
  toArchived, \* history: something reached the agent while the thread was archived
  overtaken,  \* history: comments the developer archived the thread under before their rpc was done
  stopsLeft, archivesLeft, asksLeft, crashesLeft

vars == <<status, busy, active, starting, prov, ended, awaiting, stopped, lock, queue, send, turns, pc, captured,
          deliveries, where, toArchived, overtaken, stopsLeft, archivesLeft, asksLeft, crashesLeft>>

budgets == <<stopsLeft, archivesLeft, asksLeft, crashesLeft>>
history == <<deliveries, where, toArchived, overtaken>>

Turns == 0..MaxTurns
NoSend == [pc |-> None, c |-> None, origin |-> None]
Pending == {"saved", "reopened", "steering", "queue1", "queue2", "sending", "resending"}
Pcs == {"draft", "done", "dropped", "cancelled", "crashed"} \cup Pending

TypeOK ==
  /\ status \in {"idle", "running", "archived"}
  /\ busy \in BOOLEAN /\ awaiting \in BOOLEAN /\ stopped \in BOOLEAN /\ toArchived \in BOOLEAN
  /\ active \in Turns /\ starting \in Turns /\ prov \in Turns /\ turns \in Turns
  /\ ended \in {"no", "completed", "failed"}
  /\ lock \in {"free", "finish"}
  /\ queue \in Seq([c: Comments, steer: BOOLEAN])
  /\ send.pc \in {None, "pending", "admit"}
  /\ pc \in [Comments -> Pcs]
  /\ captured \in [Comments -> Turns]
  /\ deliveries \in [Comments -> Nat]
  /\ overtaken \subseteq Comments

Init ==
  /\ status = "idle" /\ busy = FALSE /\ active = 0 /\ starting = 0 /\ prov = 0 /\ ended = "no"
  /\ awaiting = FALSE /\ stopped = FALSE /\ lock = "free" /\ queue = <<>> /\ send = NoSend /\ turns = 0
  /\ pc = [c \in Comments |-> "draft"]
  /\ captured = [c \in Comments |-> 0]
  /\ deliveries = [c \in Comments |-> 0]
  /\ where = [c \in Comments |-> {}]
  /\ toArchived = FALSE /\ overtaken = {}
  /\ stopsLeft = MaxStops /\ archivesLeft = MaxArchives /\ asksLeft = MaxAsks /\ crashesLeft = MaxCrashes

Deliver(c, provTurn, recordTurn) ==
  /\ deliveries' = [deliveries EXCEPT ![c] = @ + 1]
  /\ where' = [where EXCEPT ![c] = @ \cup {<<provTurn, recordTurn>>}]
  /\ toArchived' = (toArchived \/ status = "archived")
  /\ UNCHANGED overtaken

Queued(c) == \E i \in 1..Len(queue) : queue[i].c = c

---------------------------------------------------------------------------------------------------------------
\* A comment.

\* ArtifactFeedback.ts comment: store.comment writes feedback.json under the artifact's lock.
Save(c) ==
  /\ pc[c] = "draft"
  /\ pc' = [pc EXCEPT ![c] = "saved"]
  /\ UNCHANGED <<status, busy, active, starting, prov, ended, awaiting, stopped, lock, queue, send, turns, captured,
                 history, budgets>>

\* ArtifactFeedback.ts deliver: an archived recipient is unarchived first, as rpc.ts threads.send does.
Reopen(c) ==
  /\ pc[c] = "saved"
  /\ pc' = [pc EXCEPT ![c] = "reopened"]
  /\ status' = IF status = "archived" THEN "idle" ELSE status
  /\ UNCHANGED <<busy, active, starting, prov, ended, awaiting, stopped, lock, queue, send, turns, captured,
                 history, budgets>>

\* AgentRunner.ts steerWhen runs without an await until it waits for the lock: it reads activeTurns, and with no
\* turn sendWhen claims busyThreads or fails because a send holds it. A provider without steer goes to queue.
Lookup(c) ==
  /\ pc[c] = "reopened"
  /\ IF active # 0
       THEN /\ pc' = [pc EXCEPT ![c] = IF Steers THEN "steering" ELSE "queue1"]
            /\ captured' = [captured EXCEPT ![c] = active]
            /\ UNCHANGED <<busy, send>>
       ELSE IF busy
         THEN /\ pc' = [pc EXCEPT ![c] = "queue2"]
              /\ UNCHANGED <<busy, send, captured>>
         ELSE /\ busy' = TRUE
              /\ send' = [pc |-> "pending", c |-> c, origin |-> "deliver"]
              /\ pc' = [pc EXCEPT ![c] = "sending"]
              /\ UNCHANGED captured
  /\ UNCHANGED <<status, active, starting, prov, ended, awaiting, stopped, lock, queue, turns, history, budgets>>

\* AgentRunner.ts makeTurn steer, under the lock. A turn whose finish has run hands the message back to steerWhen.
\* With an approval open it holds the message in the queue, otherwise steerTurn calls provider.steer, which reaches
\* whatever turn the provider runs for the thread, and records the message in this turn. Every provider rejects a
\* steer with no turn running, and deliver's catch calls queue.
TurnSteer(c) ==
  /\ pc[c] = "steering" /\ lock = "free"
  /\ CASE captured[c] # active ->
            /\ pc' = [pc EXCEPT ![c] = "reopened"]
            /\ UNCHANGED <<queue, history>>
       [] awaiting ->
            /\ queue' = Append(queue, [c |-> c, steer |-> TRUE])
            /\ pc' = [pc EXCEPT ![c] = "done"]
            /\ UNCHANGED history
       [] prov # 0 ->
            /\ Deliver(c, prov, captured[c])
            /\ pc' = [pc EXCEPT ![c] = "done"]
            /\ UNCHANGED queue
       [] OTHER ->
            /\ pc' = [pc EXCEPT ![c] = "queue2"]
            /\ UNCHANGED <<queue, history>>
  /\ UNCHANGED <<status, busy, active, starting, prov, ended, awaiting, stopped, lock, send, turns, captured, budgets>>

\* AgentRunner.ts queue appends under the lock while busyThreads holds the thread, and otherwise sends.
\* From steerWhen (queue1) a failed send is an AgentError that deliver catches and queues again (queue2); from the
\* catch it is logged.
Queue(c) ==
  /\ pc[c] \in {"queue1", "queue2"} /\ lock = "free"
  /\ IF busy
       THEN /\ queue' = Append(queue, [c |-> c, steer |-> FALSE])
            /\ pc' = [pc EXCEPT ![c] = "done"]
            /\ UNCHANGED <<busy, send>>
       ELSE /\ busy' = TRUE
            /\ send' = [pc |-> "pending", c |-> c, origin |-> IF pc[c] = "queue1" THEN "deliver" ELSE "retry"]
            /\ pc' = [pc EXCEPT ![c] = IF pc[c] = "queue1" THEN "sending" ELSE "resending"]
            /\ UNCHANGED queue
  /\ UNCHANGED <<status, active, starting, prov, ended, awaiting, stopped, lock, turns, captured, history, budgets>>

---------------------------------------------------------------------------------------------------------------
\* The send a comment or the queue starts.

\* A send that fails: startClaimed frees busyThreads. A comment's own send returns the AgentError to deliver, a
\* retry is logged, and startQueued puts its message back in front.
SendFails ==
  /\ busy' = FALSE /\ stopped' = FALSE /\ send' = NoSend
  /\ CASE send.origin = "deliver" -> pc' = [pc EXCEPT ![send.c] = "queue2"] /\ UNCHANGED queue
       [] send.origin = "retry"   -> pc' = [pc EXCEPT ![send.c] = IF stopped THEN "cancelled" ELSE "dropped"]
                                     /\ UNCHANGED queue
       [] send.origin = "queued"  -> queue' = <<[c |-> send.c, steer |-> FALSE]>> \o queue /\ UNCHANGED pc

\* AgentRunner.ts startTurn's first locked block checks the stop. The worktree wait after it races the stop too.
SendPending ==
  /\ send.pc = "pending" /\ lock = "free"
  /\ IF stopped
       THEN SendFails
       ELSE /\ send' = [send EXCEPT !.pc = "admit"]
            /\ UNCHANGED <<busy, stopped, queue, pc>>
  /\ UNCHANGED <<status, active, starting, prov, ended, awaiting, lock, turns, captured, history, budgets>>

\* AgentRunner.ts startTurn's second locked block refuses an archived thread, or writes the prompt as the turn's
\* user message, marks the thread running and sets activeTurns.
SendAdmit ==
  /\ send.pc = "admit" /\ lock = "free" /\ turns < MaxTurns
  /\ IF stopped \/ status = "archived"
       THEN /\ SendFails
            /\ UNCHANGED <<status, active, starting, turns, history>>
       ELSE /\ turns' = turns + 1 /\ active' = turns + 1 /\ starting' = turns + 1
            /\ status' = "running"
            /\ Deliver(send.c, turns + 1, turns + 1)
            /\ send' = NoSend
            /\ pc' = IF send.origin = "queued" THEN pc ELSE [pc EXCEPT ![send.c] = "done"]
            /\ UNCHANGED <<busy, stopped, queue>>
  /\ UNCHANGED <<prov, ended, awaiting, lock, captured, budgets>>

---------------------------------------------------------------------------------------------------------------
\* The provider and the developer.

\* AgentRunner.ts makeTurn run starts provider.runTurn, or fails the turn if it was stopped before.
ProviderStarts ==
  /\ starting # 0
  /\ starting' = 0
  /\ IF stopped THEN ended' = "failed" /\ UNCHANGED prov ELSE prov' = starting /\ UNCHANGED ended
  /\ UNCHANGED <<status, busy, active, awaiting, stopped, lock, queue, send, turns, pc, captured, history, budgets>>

\* The agent asks for an approval.
ProviderAsks ==
  /\ prov # 0 /\ ~awaiting /\ asksLeft > 0
  /\ awaiting' = TRUE /\ asksLeft' = asksLeft - 1
  /\ UNCHANGED <<status, busy, active, starting, prov, ended, stopped, lock, queue, send, turns, pc, captured,
                 history, stopsLeft, archivesLeft, crashesLeft>>

\* AgentRunner.ts steerHeld: the developer answers, and the held messages are steered and dropped from the queue.
\* A failed steer is logged and leaves them queued.
Answer ==
  /\ awaiting /\ lock = "free"
  /\ awaiting' = FALSE
  /\ LET held == {i \in 1..Len(queue) : queue[i].steer}
         heldComments == {queue[i].c : i \in held}
     IN IF prov # 0 /\ held # {}
          THEN /\ queue' = SelectSeq(queue, LAMBDA m : ~m.steer)
               /\ deliveries' = [c \in Comments |-> deliveries[c] + Cardinality({i \in held : queue[i].c = c})]
               /\ where' = [c \in Comments |-> IF c \in heldComments THEN where[c] \cup {<<prov, active>>} ELSE where[c]]
               /\ toArchived' = (toArchived \/ status = "archived")
               /\ UNCHANGED overtaken
          ELSE UNCHANGED <<queue, history>>
  /\ UNCHANGED <<status, busy, active, starting, prov, ended, stopped, lock, send, turns, pc, captured, budgets>>

\* The provider's stream ends the turn. A turn waiting on the developer can only fail.
ProviderEnds ==
  /\ prov # 0 /\ ended = "no"
  /\ prov' = 0
  /\ \E outcome \in IF awaiting THEN {"failed"} ELSE {"completed", "failed"} : ended' = outcome
  /\ UNCHANGED <<status, busy, active, starting, awaiting, stopped, lock, queue, send, turns, pc, captured,
                 history, budgets>>

\* AgentRunner.ts interrupt: the developer stops the send in flight or the running turn, whose provider fails it.
Stop ==
  /\ stopsLeft > 0 /\ ~stopped
  /\ \/ send.pc # None /\ active = 0
     \/ active # 0 /\ ended = "no"
  /\ stopsLeft' = stopsLeft - 1 /\ stopped' = TRUE
  /\ IF prov # 0 THEN prov' = 0 /\ ended' = "failed" ELSE UNCHANGED <<prov, ended>>
  /\ UNCHANGED <<status, busy, active, starting, awaiting, lock, queue, send, turns, pc, captured, history,
                 archivesLeft, asksLeft, crashesLeft>>

\* AgentRunner.ts makeTurn handle folds turn_completed or turn_failed, and statusAfter marks the row idle before
\* finish runs.
HandleEnd ==
  /\ ended # "no" /\ status = "running" /\ lock = "free"
  /\ status' = "idle"
  /\ UNCHANGED <<busy, active, starting, prov, ended, awaiting, stopped, lock, queue, send, turns, pc, captured,
                 history, budgets>>

\* Threads.ts archiveIf refuses a thread whose row says running. It takes the worktree lock, not the thread's.
Archive ==
  /\ archivesLeft > 0 /\ status = "idle"
  /\ archivesLeft' = archivesLeft - 1 /\ status' = "archived"
  /\ overtaken' = overtaken \cup {c \in Comments : pc[c] \in Pending}
  /\ UNCHANGED <<busy, active, starting, prov, ended, awaiting, stopped, lock, queue, send, turns, pc, captured,
                 deliveries, where, toArchived, stopsLeft, asksLeft, crashesLeft>>

---------------------------------------------------------------------------------------------------------------
\* The turn's finish (AgentRunner.ts makeTurn finish), under the lock.

\* It sets finishing and withdraws open approvals.
FinishStarts ==
  /\ ended # "no" /\ status # "running" /\ starting = 0 /\ lock = "free"
  /\ lock' = "finish" /\ awaiting' = FALSE
  /\ UNCHANGED <<status, busy, active, starting, prov, ended, stopped, queue, send, turns, pc, captured,
                 history, budgets>>

\* A completed turn that was not stopped takes the queue's first message and keeps busyThreads for startQueued.
FinishReleases ==
  /\ lock = "finish"
  /\ lock' = "free" /\ active' = 0 /\ ended' = "no" /\ stopped' = FALSE
  /\ IF ended = "completed" /\ ~stopped /\ queue # <<>>
       THEN /\ send' = [pc |-> "pending", c |-> Head(queue).c, origin |-> "queued"]
            /\ queue' = Tail(queue)
            /\ UNCHANGED busy
       ELSE /\ busy' = FALSE
            /\ UNCHANGED <<send, queue>>
  /\ UNCHANGED <<status, starting, prov, awaiting, turns, pc, captured, history, budgets>>

---------------------------------------------------------------------------------------------------------------
\* The app quits or crashes. Memory is gone, Threads.ts marks a running row idle at the next start, and
\* thread.queue survives in SQLite.
Crash ==
  /\ crashesLeft > 0
  /\ crashesLeft' = crashesLeft - 1
  /\ busy' = FALSE /\ active' = 0 /\ starting' = 0 /\ prov' = 0 /\ ended' = "no" /\ awaiting' = FALSE
  /\ stopped' = FALSE /\ lock' = "free" /\ send' = NoSend
  /\ status' = IF status = "running" THEN "idle" ELSE status
  /\ pc' = [c \in Comments |-> IF pc[c] \in Pending THEN "crashed" ELSE pc[c]]
  /\ UNCHANGED <<queue, turns, captured, history, stopsLeft, archivesLeft, asksLeft>>

Runner ==
  \/ \E c \in Comments : Reopen(c) \/ Lookup(c) \/ TurnSteer(c) \/ Queue(c)
  \/ SendPending \/ SendAdmit \/ ProviderStarts \/ HandleEnd \/ FinishStarts \/ FinishReleases

Next ==
  \/ Runner
  \/ \E c \in Comments : Save(c)
  \/ ProviderAsks \/ Answer \/ ProviderEnds \/ Stop \/ Archive \/ Crash

Spec == Init /\ [][Next]_vars

\* The runner's own steps always run, the agent ends its turns, and the developer answers approvals.
LiveSpec ==
  /\ Spec
  /\ \A c \in Comments : WF_vars(Reopen(c)) /\ WF_vars(Lookup(c)) /\ WF_vars(TurnSteer(c)) /\ WF_vars(Queue(c))
  /\ WF_vars(SendPending) /\ WF_vars(SendAdmit) /\ WF_vars(ProviderStarts)
  /\ WF_vars(HandleEnd) /\ WF_vars(FinishStarts) /\ WF_vars(FinishReleases)
  /\ WF_vars(Answer) /\ WF_vars(ProviderEnds)

---------------------------------------------------------------------------------------------------------------
\* Properties.

\* No comment reaches the agent twice.
NeverTwice == \A c \in Comments : deliveries[c] <= 1

\* AgentRunner writes a steered comment into the turn the provider gave it to.
RightTurn == \A c \in Comments : \A d \in where[c] : d[1] = d[2]

\* Nothing reaches an archived thread.
NeverToArchived == ~toArchived

\* A saved comment the rpc is done with reached the agent or waits in the thread's queue, which the composer shows.
\* The developer may cancel it by stopping its send, or by archiving the thread before it arrives.
Lost(c) ==
  /\ pc[c] \in {"done", "dropped", "crashed"}
  /\ deliveries[c] = 0 /\ ~Queued(c) /\ send.c # c
  /\ c \notin overtaken
NoSilentLoss == \A c \in Comments : ~Lost(c)

\* Every saved comment reaches the agent, comes to rest in the queue of a thread nothing holds, or the developer
\* cancelled it.
Cancelled(c) == pc[c] = "cancelled" \/ c \in overtaken
Settles ==
  \A c \in Comments : pc[c] = "saved" ~> (deliveries[c] > 0 \/ (Queued(c) /\ ~busy) \/ Cancelled(c) \/ Lost(c))

=================================================================================================================
